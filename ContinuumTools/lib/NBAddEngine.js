// ----------------------------------------------------------------------------
// ContinuumTools - Add Narrowband to RGB engine
// ----------------------------------------------------------------------------
//
// Adds stretched, continuum-subtracted narrowband masters to a stretched RGB
// (LRGB) image, per channel, with the soft addition of this PixelMath:
//
//    $T * ~W + W * mtf( ~m, mtf( m, $T ) + mtf( m, NB ) )      (W = R, G or B weight)
//
// mtf(m, .) followed by mtf(1-m, .) is a transform and its inverse, so the
// two images are added in the transformed space. For m near 1 that space is
// the "odds" x/(1-x) (scaled), and the result is
//
//    odds(out) = odds(T) + odds(NB)
//
// which adds faint signal almost linearly but can never push a pixel past 1:
// highlights and star cores roll off smoothly instead of clipping. m = 0.5
// makes the transform the identity: a plain (clipping) addition.
// The channel weight then blends that sum into each channel: 1 = all of it,
// 0 = none, above 1 = more (e.g. B 1.5 for OIII's teal).
//
// Additions beyond the original PixelMath (the defaults leave them neutral,
// so default results equal the PixelMath exactly):
//   strength  - scales the narrowband term in the transformed space
//   black     - narrowband black point, so its background level is not
//               added to the RGB background (which would tint it)
// Several lines are applied one after another (H-alpha, OIII, SII), each
// result truncated to [0,1], exactly like running the PixelMath instances
// in that order.
// ----------------------------------------------------------------------------

var NBADD = {};

NBADD.TOOL = "NBADD";

NBADD.LINES = [
   { key: "ha", label: "Hα" },
   { key: "o3", label: "OIII" },
   { key: "s2", label: "SII" }
];

NBADD.defaults = function()
{
   return {
      m: 0.999,
      // H-alpha and OIII: the weights of the original PixelMath instances
      ha_r: 1.0, ha_g: 0.0, ha_b: 0.05, ha_strength: 1.0, ha_black: 0.0,
      o3_r: 0.0, o3_g: 1.0, o3_b: 1.5,  o3_strength: 1.0, o3_black: 0.0,
      // SII: a starting point (deep red, slightly warmer than H-alpha)
      s2_r: 1.0, s2_g: 0.2, s2_b: 0.0,  s2_strength: 1.0, s2_black: 0.0,
      newImage: true,
      suffix: "_NB"
   };
};

NBADD.weights = function( p, key )
{
   return [ p[key + "_r"], p[key + "_g"], p[key + "_b"] ];
};

// Same definition as PixelMath's mtf(): clamped to [0,1].
NBADD.mtf = function( m, x )
{
   if ( x <= 0 ) return 0;
   if ( x >= 1 ) return 1;
   return ( ( m - 1 ) * x ) / ( ( 2 * m - 1 ) * x - m );
};

// Adds one narrowband buffer to the channel buffers, in place.
NBADD.addLine = function( chans, nb, p, key )
{
   let m = p.m, im = 1 - m;
   let s = p[key + "_strength"], bp = p[key + "_black"];
   let w = NBADD.weights( p, key );
   let n = nb.length;
   let ibp = bp < 1 ? 1 / ( 1 - bp ) : 0;
   let a1 = m - 1, b1 = 2 * m - 1;          // mtf( m, x ) = a1 x / ( b1 x - m )
   let a2 = im - 1, b2 = 2 * im - 1;        // mtf( 1-m, y )
   // the narrowband term, transformed once
   let q = new Float32Array( n );
   for ( let i = 0; i < n; ++i )
   {
      let x = bp > 0 ? ( nb[i] - bp ) * ibp : nb[i];
      q[i] = x <= 0 ? 0 : x >= 1 ? s : s * ( a1 * x ) / ( b1 * x - m );
   }
   for ( let c = 0; c < chans.length && c < 3; ++c )
   {
      let wc = w[c];
      if ( wc == 0 )
         continue;
      let T = chans[c];
      for ( let i = 0; i < n; ++i )
      {
         let t = T[i];
         let u = t <= 0 ? 0 : t >= 1 ? 1 : ( a1 * t ) / ( b1 * t - m );
         let y = u + q[i];
         let comb = y <= 0 ? 0 : y >= 1 ? 1 : ( a2 * y ) / ( b2 * y - im );
         let v = t + wc * ( comb - t );
         T[i] = v < 0 ? 0 : v > 1 ? 1 : v;
      }
   }
};

// lines: [ { key, data } ] in application order. Returns new channel buffers.
NBADD.apply = function( target, lines, p )
{
   let out = target.map( function( a ) { return Float32Array.from( a ); } );
   for ( let l of lines )
      NBADD.addLine( out, l.data, p, l.key );
   return out;
};

// Automatic black point for a stretched narrowband image: the level of its
// darkest areas (0.5th percentile of 8x8 block medians, which ignore noise).
NBADD.autoBlack = function( nb, W, H )
{
   let d = CT.downsampleMedian( nb, W, H, 8 );
   let s = Float32Array.from( d.a );
   s.sort();
   return CT.quantileSorted( s, 0.005 );
};

NBADD.validate = function( target, views )
{
   if ( !CT.isView( target ) )
      throw new Error( "Select the RGB image." );
   if ( target.image.numberOfChannels < 3 )
      throw new Error( "The target must be an RGB image." );
   let n = 0;
   for ( let key in views )
      if ( CT.isView( views[key] ) )
      {
         if ( views[key].id == target.id )
            throw new Error( "A narrowband image cannot be the target itself." );
         CT.requireSameGeometry( target, views[key], "RGB / narrowband" );
         ++n;
      }
   if ( n == 0 )
      throw new Error( "Select at least one narrowband image." );
};

// Loads pixel data. views: { ha, o3, s2 } (any may be empty).
NBADD.load = function( target, views )
{
   NBADD.validate( target, views );
   let g = CT.geometry( target );
   let d = { W: g.W, H: g.H, target: [], lines: [], ids: [ target.id ] };
   for ( let c = 0; c < 3; ++c )
      d.target.push( CT.getChannel( target, c ) );
   for ( let L of NBADD.LINES )
   {
      let v = views[L.key];
      d.ids.push( CT.isView( v ) ? v.id : "" );
      if ( !CT.isView( v ) )
         continue;
      if ( v.image.numberOfChannels > 1 )
         CT.warn( v.id + " is a color image; its first channel is used." );
      d.lines.push( { key: L.key, data: CT.getChannel( v, 0 ) } );
   }
   d.ids = d.ids.join( "|" );
   let st = CT.robustStats( d.target[0] );
   d.looksLinear = st.median < 0.01;
   return d;
};

// Mask of the target window as a [0,1] buffer (inverted if the window says so),
// or null when no mask is active.
NBADD.windowMask = function( view, W, H )
{
   try
   {
      let win = view.window;
      if ( !win.maskEnabled )
         return null;
      let mw = win.mask;
      if ( mw === null || mw === undefined || mw.isNull )
         return null;
      let mv = mw.mainView;
      if ( mv.image.width != W || mv.image.height != H )
         return null;
      let m = CT.getLuminance( mv );
      if ( win.maskInverted )
         for ( let i = 0; i < m.length; ++i ) m[i] = 1 - m[i];
      return m;
   }
   catch ( e )
   {
      return null;
   }
};

NBADD.history = function( d, p )
{
   let h = [ "ContinuumTools AddNarrowbandToRGB " + CT.VERSION + ": m=" + CT.fmt( p.m, 4 ) ];
   for ( let l of d.lines )
      h.push( l.key + ": R=" + CT.fmt( p[l.key + "_r"], 3 ) + " G=" + CT.fmt( p[l.key + "_g"], 3 ) +
              " B=" + CT.fmt( p[l.key + "_b"], 3 ) + " strength=" + CT.fmt( p[l.key + "_strength"], 3 ) +
              " black=" + CT.fmt( p[l.key + "_black"], 4 ) );
   return h;
};

// Creates the result (new image, or the target modified in place).
NBADD.execute = function( d, target, p )
{
   let t0 = Date.now();
   let out = NBADD.apply( d.target, d.lines, p );
   // Honor the target's mask like PixelMath does. Pixels written by a script
   // do not go through the mask (verified), so it is applied here, for both
   // a new image and an in-place change.
   let mask = NBADD.windowMask( target, d.W, d.H );
   if ( mask )
   {
      for ( let c = 0; c < 3; ++c )
      {
         let o = out[c], t = d.target[c];
         for ( let i = 0; i < o.length; ++i )
            o[i] = t[i] + mask[i] * ( o[i] - t[i] );
      }
      CT.log( "The target's mask was applied." );
   }
   let win;
   if ( p.newImage )
      win = CT.createWindow( target.id + p.suffix, d.W, d.H, out,
                             { keywordsFrom: target, history: NBADD.history( d, p ) } );
   else
   {
      CT.writeToView( target, out );   // undoable
      win = target.window;
   }
   CT.note( format( "%s %s (%.1f s)", p.newImage ? "Created" : "Updated", win.mainView.id, ( Date.now() - t0 ) / 1000 ) );
   return win;
};

// Preview ---------------------------------------------------------------------

NBADD.previewSetup = function( d, maxW, maxH )
{
   let f = CT.previewFactor( d.W, d.H, maxW, maxH );
   let pv = { f: f };
   let d0 = CT.downsample( d.target[0], d.W, d.H, f );
   pv.W = d0.W; pv.H = d0.H;
   pv.target = d.target.map( function( a ) { return CT.downsample( a, d.W, d.H, f ).a; } );
   pv.lines = d.lines.map( function( l ) { return { key: l.key, data: CT.downsample( l.data, d.W, d.H, f ).a }; } );
   // stretched data is shown as it is; a linear target gets an AutoSTF
   pv.stretch = d.looksLinear ? pv.target.map( function( a ) { return CT.autoStretch( a ); } )
                              : [ { c0: 0, m: 0.5 } ];
   d.preview = pv;
   return pv;
};

NBADD.previewBitmap = function( d, p, showOriginal )
{
   let pv = d.preview;
   let ch = showOriginal ? pv.target : NBADD.apply( pv.target, pv.lines, p );
   return CT.renderBitmap( ch, pv.W, pv.H, pv.stretch );
};
