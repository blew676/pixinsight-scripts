// ----------------------------------------------------------------------------
// ContinuumTools - Broadband Line Removal engine
// ----------------------------------------------------------------------------
//
// Removes emission-line light from broadband images, leaving the continuum:
// starlight, reflection nebulae, dust and IFN.
//
//    Continuum = BB - a * ( Line - L0 )
//
// Line is a continuum-subtracted narrowband image (the output of Narrowband
// Continuum Subtraction, normally starless so the broadband stars are left
// untouched) and L0 its zero-emission level. Per broadband channel:
//
//    R  <- H-alpha (+ [NII], which a wide red filter passes but a 3 nm H-alpha
//          filter mostly does not)
//    G  <- OIII (500.7 nm sits near the blue edge of most green filters)
//    B  <- OIII, and H-beta (scaled from the H-alpha line image)
//
// Starting amounts (physics):  c = (t_BB / t_NB) * F,   a = c / (1 - k*c)
//   t = sub exposure times, F = filter factor (transmission ratio, [NII] etc.),
//   k = the continuum factor used to make the line image (read from its
//   HISTORY); the 1/(1-k c) term restores the line light that was removed
//   together with the continuum when the line image was made.
// Image estimate: lower envelope of BB versus Line (continuum is independent
// of the line, so the floor of BB at each line level rises with slope a).
// The preview is the final judge: the bright emission fronts should vanish
// from the broadband image without leaving a dark imprint.
// ----------------------------------------------------------------------------

var BBLR = {};

BBLR.TOOL = "BBLR";

// Rows: R, G, B. Columns: H-alpha line, OIII line.
BBLR.ROWS = [
   { key: "aR_Ha", ch: 0, line: 0, label: "R ← Hα",        fKey: "fHaR", tLine: "tHa" },
   { key: "aG_O3", ch: 1, line: 1, label: "G ← OIII",           fKey: "fO3G", tLine: "tO3" },
   { key: "aB_O3", ch: 2, line: 1, label: "B ← OIII",           fKey: "fO3B", tLine: "tO3" },
   { key: "aB_Ha", ch: 2, line: 0, label: "B ← Hβ (from Hα)", fKey: "fHaB", tLine: "tHa" }
];

BBLR.defaults = function()
{
   return {
      monoFilter: 0,           // mono target: 0 = R, 1 = G, 2 = B (selects which rows apply)
      aR_Ha: 0, aG_O3: 0, aB_O3: 0, aB_Ha: 0,
      tBB: 0, tHa: 0, tO3: 0,  // sub exposures (s); read from keywords when available
      fHaR: 1.40,              // H-alpha (+[NII]) in a wide R filter vs a 3 nm H-alpha filter
      fO3G: 0.50,              // OIII at the edge of a G filter (filter dependent)
      fO3B: 1.00,              // OIII inside a B filter
      fHaB: 0.30,              // H-beta / H-alpha (Balmer decrement with some extinction)
      clipCount: 0,
      suffix: "_continuum"
   };
};

// Which rows apply to this target / line selection.
BBLR.activeRows = function( isColor, p, hasHa, hasO3 )
{
   let rows = [];
   for ( let r of BBLR.ROWS )
   {
      if ( r.line == 0 && !hasHa ) continue;
      if ( r.line == 1 && !hasO3 ) continue;
      if ( !isColor && r.ch != p.monoFilter ) continue;
      rows.push( r );
   }
   return rows;
};

// Reads "k=<number>" from an NBCS HISTORY keyword, or 0.
BBLR.lineK = function( view )
{
   if ( !CT.isView( view ) )
      return 0;
   try
   {
      let kw = view.window.keywords;
      for ( let i = 0; i < kw.length; ++i )
         if ( kw[i].name.trim() == "HISTORY" )
         {
            let m = /\bk=([0-9.]+)/.exec( kw[i].comment + " " + kw[i].value );
            if ( m ) return parseFloat( m[1] );
         }
   }
   catch ( e ) {}
   return 0;
};

// Physics-based starting amounts. Returns { key: amount } for active rows.
BBLR.physicsEstimate = function( p, rows, kHa, kO3 )
{
   let out = {};
   for ( let r of rows )
   {
      let tNB = p[ r.tLine ];
      if ( !( p.tBB > 0 && tNB > 0 ) )
         continue;
      let c = ( p.tBB / tNB ) * p[ r.fKey ];
      // the 1/(1-kc) term applies when the line was made against this same channel
      let k = ( r.key == "aR_Ha" ) ? kHa : ( r.key == "aG_O3" || r.key == "aB_O3" ) ? kO3 : 0;
      out[ r.key ] = c / Math.max( 0.2, 1 - k * c );
   }
   return out;
};

// Zero-emission level of a line image: low percentile of block medians.
BBLR.lineZero = function( line, W, H )
{
   let d = CT.downsampleMedian( line, W, H, 8 );
   let s = Float32Array.from( d.a );
   s.sort();
   return CT.quantileSorted( s, 0.005 );
};

// Image-based amount: robust regression of the broadband image against the
// line image on band-passed, star-rejecting block medians (structures of
// roughly 20-100 px). Emission fronts are the dominant shared structure at
// those scales; the band-pass removes gradients and large dust clouds, and
// the iterative clipping rejects star residuals and other outliers.
BBLR.imageEstimate = function( bb, line, W, H, L0 )
{
   let f = 8;
   let A = CT.downsampleMedian( line, W, H, f ), B = CT.downsampleMedian( bb, W, H, f );
   let la = CT.boxBlur( A.a, A.W, A.H, 6 ), lb = CT.boxBlur( B.a, B.W, B.H, 6 );
   let n = A.a.length;
   let xs = new Float64Array( n ), ys = new Float64Array( n );
   let sxx = 0, sxy = 0;
   for ( let i = 0; i < n; ++i )
   {
      xs[i] = A.a[i] - la[i];
      ys[i] = B.a[i] - lb[i];
      sxx += xs[i] * xs[i];
      sxy += xs[i] * ys[i];
   }
   if ( !( sxx > 0 ) )
      throw new Error( "The line image has no structure to compare with." );
   let a = sxy / sxx;
   let res = new Float64Array( n );
   for ( let it = 0; it < 5; ++it )
   {
      for ( let i = 0; i < n; ++i )
         res[i] = Math.abs( ys[i] - a * xs[i] );
      let s = 3 * 1.4826 * CT.median( res );
      let nxy = 0, nxx = 0;
      for ( let i = 0; i < n; ++i )
         if ( res[i] < s ) { nxy += xs[i] * ys[i]; nxx += xs[i] * xs[i]; }
      if ( nxx > 0 )
         a = nxy / nxx;
   }
   return Math.max( 0, a );
};

BBLR.validate = function( target, ha, o3 )
{
   if ( !CT.isView( target ) )
      throw new Error( "Select the broadband image." );
   if ( !CT.isView( ha ) && !CT.isView( o3 ) )
      throw new Error( "Select at least one line image (H-alpha or OIII)." );
   if ( CT.isView( ha ) ) CT.requireSameGeometry( target, ha, "Broadband / H-alpha line" );
   if ( CT.isView( o3 ) ) CT.requireSameGeometry( target, o3, "Broadband / OIII line" );
};

// Loads pixel data. Returns a data object reused for previews and output.
BBLR.load = function( target, ha, o3 )
{
   BBLR.validate( target, ha, o3 );
   let g = CT.geometry( target );
   let d = { W: g.W, H: g.H, color: g.C >= 3, ids: [ target.id, CT.isView( ha ) ? ha.id : "", CT.isView( o3 ) ? o3.id : "" ].join( "|" ) };
   d.bb = [];
   for ( let c = 0; c < ( d.color ? 3 : 1 ); ++c )
      d.bb.push( CT.getChannel( target, c ) );
   d.lines = [ null, null ];
   d.L0 = [ 0, 0 ];
   if ( CT.isView( ha ) ) { d.lines[0] = CT.getChannel( ha, 0 ); d.L0[0] = BBLR.lineZero( d.lines[0], g.W, g.H ); }
   if ( CT.isView( o3 ) ) { d.lines[1] = CT.getChannel( o3, 0 ); d.L0[1] = BBLR.lineZero( d.lines[1], g.W, g.H ); }
   d.kHa = BBLR.lineK( ha );
   d.kO3 = BBLR.lineK( o3 );
   CT.log( format( "Line zero levels: H-alpha %.6f, OIII %.6f; line k from history: %.4f / %.4f",
                   d.L0[0], d.L0[1], d.kHa, d.kO3 ) );
   return d;
};

// out_c = bb_c - sum a * (line - L0) for one set of buffers (full or preview).
BBLR.apply = function( bbCh, lines, L0, color, p, out )
{
   let rows = BBLR.activeRows( color, p, !!lines[0], !!lines[1] );
   let res = out || bbCh.map( function( a ) { return new Float32Array( a.length ); } );
   for ( let c = 0; c < bbCh.length; ++c )
   {
      let src = bbCh[c], dst = res[c];
      dst.set( src );
      for ( let r of rows )
      {
         let ch = color ? r.ch : 0;
         if ( ch != c )
            continue;
         let a = p[ r.key ];
         if ( !( a != 0 ) )
            continue;
         let L = lines[ r.line ], z = L0[ r.line ];
         for ( let i = 0, n = dst.length; i < n; ++i )
            dst[i] -= a * ( L[i] - z );
      }
   }
   return res;
};

BBLR.execute = function( data, target, p )
{
   let t0 = Date.now();
   let out = BBLR.apply( data.bb, data.lines, data.L0, data.color, p );
   let low = 0;
   for ( let c = 0; c < out.length; ++c )
      for ( let i = 0, n = out[c].length; i < n; ++i )
         if ( out[c][i] < 0 ) ++low;
   if ( low > 0 )
      CT.warn( low + " samples went below zero and were clipped. If this is more than a " +
               "handful, the amount is too high." );
   let rows = BBLR.activeRows( data.color, p, !!data.lines[0], !!data.lines[1] );
   let hist = [ "ContinuumTools BBLR " + CT.VERSION + ": line light removed from " + target.id,
                rows.map( function( r ) { return r.key + "=" + CT.fmt( p[r.key], 4 ); } ).join( " " ) ];
   let win = CT.createWindow( target.id + p.suffix, data.W, data.H, out, { keywordsFrom: target, history: hist } );
   CT.note( format( "Created %s (%.1f s)", win.mainView.id, ( Date.now() - t0 ) / 1000 ) );
   return win;
};

// Preview buffers.
BBLR.previewSetup = function( data, maxW, maxH )
{
   let f = CT.previewFactor( data.W, data.H, maxW, maxH );
   let pv = { f: f };
   pv.bb = data.bb.map( function( a ) { return CT.downsample( a, data.W, data.H, f ).a; } );
   let d0 = CT.downsample( data.bb[0], data.W, data.H, f );
   pv.W = d0.W; pv.H = d0.H;
   pv.lines = data.lines.map( function( a ) { return a ? CT.downsample( a, data.W, data.H, f ).a : null; } );
   pv.out = pv.bb.map( function( a ) { return new Float32Array( a.length ); } );
   pv.stretch = pv.bb.map( function( a ) { return CT.autoStretch( a ); } );
   data.preview = pv;
   return pv;
};

BBLR.previewBitmap = function( data, p, showOriginal )
{
   let pv = data.preview;
   let ch = showOriginal ? pv.bb : BBLR.apply( pv.bb, pv.lines, data.L0, data.color, p, pv.out );
   return CT.renderBitmap( ch, pv.W, pv.H, pv.stretch );
};
