// ----------------------------------------------------------------------------
// ContinuumTools - Add Narrowband to RGB engine
// ----------------------------------------------------------------------------
//
// Adds stretched, continuum-subtracted narrowband masters to a stretched RGB
// (LRGB) image. Each line (H-alpha, OIII, SII) has three independent parts,
// applied in this order:
//
// 1. Colour - the original PixelMath, per channel (W = that channel's weight):
//
//       $T * ~W + W * mtf( ~m, mtf( m, $T ) + mtf( m, NB ) )
//
//    mtf(m, .) followed by mtf(1-m, .) is a transform and its inverse, so the
//    two images are added in the transformed space. For m near 1 that space
//    is the "odds" x/(1-x) (scaled):  odds(out) = odds(T) + odds(NB). Faint
//    signal adds almost linearly, but nothing can pass 1: highlights roll off
//    instead of clipping. m = 0.5 makes it a plain (clipping) addition.
//
// 2. Luminance - the same soft addition, applied to the CIE L* lightness of
//    the image only (PixInsight's getLightness/setLightness), so the line
//    brightens the image without changing hue or saturation.
//
// 3. Detail - where the line is strong, the image's fine lightness structure
//    (and its noise) is rebuilt from the cleaner narrowband image with a
//    guided filter: in every (2r+1)^2 window L ~ a*NB + b is fitted, so the
//    result follows NB's structure at L's own local brightness and contrast.
//    Only noise-sized differences are replaced (fully up to 2x the lightness
//    noise, fading out by 4x), so stars and features the narrowband image
//    does not have (it is starless) are left alone, and a mask from the
//    narrowband brightness limits it to where the line really has signal.
//
// Defaults leave luminance, detail, strength and black point neutral, so
// default results equal the two PixelMath instances exactly (Ha then OIII,
// each truncated to [0,1]).
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
      detailRadius: 3,          // guided filter window radius (px)
      // H-alpha and OIII: the weights of the original PixelMath instances
      ha_r: 1.0, ha_g: 0.0, ha_b: 0.05, ha_strength: 1.0, ha_black: 0.0, ha_lum: 0.0, ha_detail: 0.0,
      o3_r: 0.0, o3_g: 1.0, o3_b: 1.5,  o3_strength: 1.0, o3_black: 0.0, o3_lum: 0.0, o3_detail: 0.0,
      // SII: a starting point (deep red, slightly warmer than H-alpha)
      s2_r: 1.0, s2_g: 0.2, s2_b: 0.0,  s2_strength: 1.0, s2_black: 0.0, s2_lum: 0.0, s2_detail: 0.0,
      newImage: true,
      suffix: "_NB"
   };
};

// Per-line parameter names saved between sessions.
NBADD.LINE_PARAMS = [ "r", "g", "b", "strength", "black", "lum", "detail" ];

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

// Narrowband with its black point removed, clipped to [0,1].
NBADD.blackPointed = function( nb, bp )
{
   let out = new Float32Array( nb.length );
   let ibp = bp < 1 ? 1 / ( 1 - bp ) : 0;
   for ( let i = 0; i < nb.length; ++i )
   {
      let x = bp > 0 ? ( nb[i] - bp ) * ibp : nb[i];
      out[i] = x < 0 ? 0 : x > 1 ? 1 : x;
   }
   return out;
};

// 1. Colour: adds one narrowband buffer to the channel buffers, in place.
NBADD.addColor = function( chans, nb, p, key )
{
   let w = NBADD.weights( p, key );
   if ( w[0] == 0 && w[1] == 0 && w[2] == 0 )
      return;
   let m = p.m, im = 1 - m;
   let s = p[key + "_strength"], bp = p[key + "_black"];
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

// Kept for callers of the 1.1.0 engine.
NBADD.addLine = NBADD.addColor;

// Soft addition of N into L (both [0,1]), in place: L = mtf(1-m, mtf(m,L) + s*mtf(m,N)).
NBADD.softAdd = function( L, N, s, m )
{
   let im = 1 - m;
   let a1 = m - 1, b1 = 2 * m - 1, a2 = im - 1, b2 = 2 * im - 1;
   for ( let i = 0; i < L.length; ++i )
   {
      let t = L[i], x = N[i];
      let u = t <= 0 ? 0 : t >= 1 ? 1 : ( a1 * t ) / ( b1 * t - m );
      let q = x <= 0 ? 0 : x >= 1 ? s : s * ( a1 * x ) / ( b1 * x - m );
      let y = u + q;
      L[i] = y <= 0 ? 0 : y >= 1 ? 1 : ( a2 * y ) / ( b2 * y - im );
   }
};

// 3. Detail: guided-filter rebuild of L's fine structure from N, in place,
// in horizontal strips (bounded memory). ctx.scale is the downsampling of the
// buffers relative to the full image (noise and radii scale with it).
NBADD.detail = function( L, N, W, H, p, key, ctx )
{
   let st = ctx.lineStats[key];
   let amount = p[key + "_detail"];
   let scale = ctx.scale || 1;
   let r = Math.max( 1, Math.round( p.detailRadius / scale ) );
   let rm = Math.max( 2, Math.round( 8 / scale ) );           // mask smoothing radius
   let sN = st.sigmaN / scale, sL = ctx.sigmaL / scale;        // noise at this scale
   let eps = Math.max( 1e-12, ( 2 * sN ) * ( 2 * sN ) );
   // only noise-sized differences are replaced: fully up to 2 sigma, fading
   // to nothing at 4 sigma (stars, features the line lacks: untouched)
   let t1 = 2 * sL, t2 = 4 * sL, itd = 1 / Math.max( 1e-12, t2 - t1 );
   // mask thresholds in black-pointed units
   let bp = p[key + "_black"], ibp = bp < 1 ? 1 / ( 1 - bp ) : 0;
   let lo = Math.max( 0, ( st.lo - bp ) * ibp ), hi = Math.max( lo + 1e-6, ( st.hi - bp ) * ibp );
   let iw = 1 / ( hi - lo );

   let L0 = Float32Array.from( L );   // the strips read the unmodified lightness
   let margin = 2 * r + rm + 2;
   let strip = 256;
   for ( let y0 = 0; y0 < H; y0 += strip )
   {
      let y1 = Math.min( H, y0 + strip );
      let a0 = Math.max( 0, y0 - margin ), a1 = Math.min( H, y1 + margin );
      let h = a1 - a0, n = W * h;
      let Ls = L0.subarray( a0 * W, a1 * W ), Ns = N.subarray( a0 * W, a1 * W );
      let mN = CT.boxBlur( Ns, W, h, r ), mL = CT.boxBlur( Ls, W, h, r );
      let t = new Float32Array( n );
      for ( let i = 0; i < n; ++i ) t[i] = Ns[i] * Ns[i];
      let mNN = CT.boxBlur( t, W, h, r );
      for ( let i = 0; i < n; ++i ) t[i] = Ns[i] * Ls[i];
      let mNL = CT.boxBlur( t, W, h, r );
      let A = t, B = mNN;   // reuse buffers
      for ( let i = 0; i < n; ++i )
      {
         let varN = mNN[i] - mN[i] * mN[i];
         let a = ( mNL[i] - mN[i] * mL[i] ) / ( ( varN > 0 ? varN : 0 ) + eps );
         A[i] = a;
         B[i] = mL[i] - a * mN[i];
      }
      let mA = CT.boxBlur( A, W, h, r ), mB = CT.boxBlur( B, W, h, r );
      let mask = CT.boxBlur( Ns, W, h, rm );
      for ( let y = y0; y < y1; ++y )
      {
         let rs = ( y - a0 ) * W, rd = y * W;
         for ( let x = 0; x < W; ++x )
         {
            let i = rs + x;
            let wv = ( mask[i] - lo ) * iw;
            if ( wv <= 0 )
               continue;
            if ( wv > 1 ) wv = 1; else wv = wv * wv * ( 3 - 2 * wv );
            let q = mA[i] * Ns[i] + mB[i];
            let d = q - Ls[i];
            let ad = d < 0 ? -d : d;
            if ( ad >= t2 )
               continue;
            let gd = ad <= t1 ? 1 : ( t2 - ad ) * itd;
            let v = Ls[i] + amount * wv * gd * d;
            L[rd + x] = v < 0 ? 0 : v > 1 ? 1 : v;
         }
      }
      if ( ( y0 & 1023 ) == 0 )
         CT.yieldUI();
   }
};

// 2 + 3: luminance and detail act on the lightness only (hue and saturation
// kept), through PixInsight's CIE L* conversion. chans modified in place.
NBADD.lightnessStep = function( chans, nb, p, key, ctx )
{
   let lum = p[key + "_lum"], det = p[key + "_detail"];
   if ( !( lum > 0 ) && !( det > 0 ) )
      return;
   let W = ctx.W, H = ctx.H;
   let img = new Image( W, H, 3, ColorSpace.RGB );
   for ( let c = 0; c < 3; ++c )
      img.setSamples( chans[c], new Rect, c );
   let Limg = new Image;
   img.getLightness( Limg );
   let L = new Float32Array( W * H );
   Limg.getSamples( L, new Rect, 0 );
   let N = NBADD.blackPointed( nb, p[key + "_black"] );
   if ( lum > 0 )
      NBADD.softAdd( L, N, lum, p.m );
   if ( det > 0 )
      NBADD.detail( L, N, W, H, p, key, ctx );
   Limg.setSamples( L, new Rect, 0 );
   img.setLightness( Limg );
   for ( let c = 0; c < 3; ++c )
   {
      let a = chans[c];
      img.getSamples( a, new Rect, c );
      for ( let i = 0; i < a.length; ++i )
      {
         let v = a[i];
         if ( !( v > 0 ) ) a[i] = 0; else if ( v > 1 ) a[i] = 1;
      }
   }
   Limg.free();
   img.free();
};

// target: 3 channel buffers; lines: [ { key, data } ] in application order.
// ctx: { W, H, scale, sigmaL, lineStats } (see NBADD.load). Returns new buffers.
NBADD.apply = function( target, lines, p, ctx )
{
   let out = target.map( function( a ) { return Float32Array.from( a ); } );
   for ( let l of lines )
   {
      NBADD.addColor( out, l.data, p, l.key );
      if ( ctx )
         NBADD.lightnessStep( out, l.data, p, l.key, ctx );
   }
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

// Lightness noise of RGB buffers (for the detail cap).
NBADD.lightnessNoise = function( chans, W, H )
{
   let img = new Image( W, H, 3, ColorSpace.RGB );
   for ( let c = 0; c < 3; ++c )
      img.setSamples( chans[c], new Rect, c );
   let Limg = new Image;
   img.getLightness( Limg );
   let L = new Float32Array( W * H );
   Limg.getSamples( L, new Rect, 0 );
   Limg.free();
   img.free();
   return CT.noiseSigma( L, W, H );
};

// Loads pixel data and the statistics the detail step needs.
// views: { ha, o3, s2 } (any may be empty).
NBADD.load = function( target, views )
{
   NBADD.validate( target, views );
   let g = CT.geometry( target );
   let d = { W: g.W, H: g.H, target: [], lines: [], ids: [ target.id ], lineStats: {} };
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
      let data = CT.getChannel( v, 0 );
      d.lines.push( { key: L.key, data: data } );
      // where the line is "strong": between the 40th and 85th percentile of
      // its block-median brightness (the detail mask fades in over that range)
      let bm = Float32Array.from( CT.downsampleMedian( data, g.W, g.H, 8 ).a );
      bm.sort();
      d.lineStats[L.key] = { sigmaN: CT.noiseSigma( data, g.W, g.H ),
                             lo: CT.quantileSorted( bm, 0.40 ), hi: CT.quantileSorted( bm, 0.85 ) };
   }
   d.ids = d.ids.join( "|" );
   d.sigmaL = NBADD.lightnessNoise( d.target, g.W, g.H );
   let st = CT.robustStats( d.target[0] );
   d.looksLinear = st.median < 0.01;
   return d;
};

NBADD.context = function( d, W, H, scale )
{
   return { W: W, H: H, scale: scale, sigmaL: d.sigmaL, lineStats: d.lineStats };
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
   let h = [ "ContinuumTools AddNarrowbandToRGB " + CT.VERSION + ": m=" + CT.fmt( p.m, 4 ) +
             " detail radius=" + p.detailRadius ];
   for ( let l of d.lines )
      h.push( l.key + ": R=" + CT.fmt( p[l.key + "_r"], 3 ) + " G=" + CT.fmt( p[l.key + "_g"], 3 ) +
              " B=" + CT.fmt( p[l.key + "_b"], 3 ) + " strength=" + CT.fmt( p[l.key + "_strength"], 3 ) +
              " black=" + CT.fmt( p[l.key + "_black"], 4 ) + " luminance=" + CT.fmt( p[l.key + "_lum"], 3 ) +
              " detail=" + CT.fmt( p[l.key + "_detail"], 3 ) );
   return h;
};

// Creates the result (new image, or the target modified in place).
NBADD.execute = function( d, target, p )
{
   let t0 = Date.now();
   let out = NBADD.apply( d.target, d.lines, p, NBADD.context( d, d.W, d.H, 1 ) );
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

// Whole image, downsampled.
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
   d.crop = null;
   return pv;
};

// A full-resolution crop centred on (cx, cy) for judging fine detail. The
// crop is computed with a margin so the filters see real surroundings.
NBADD.cropSetup = function( d, cx, cy, cw, ch )
{
   cw = Math.min( cw, d.W ); ch = Math.min( ch, d.H );
   let x0 = Math.max( 0, Math.min( d.W - cw, Math.round( cx - cw / 2 ) ) );
   let y0 = Math.max( 0, Math.min( d.H - ch, Math.round( cy - ch / 2 ) ) );
   let M = 64;
   let ex0 = Math.max( 0, x0 - M ), ey0 = Math.max( 0, y0 - M );
   let ex1 = Math.min( d.W, x0 + cw + M ), ey1 = Math.min( d.H, y0 + ch + M );
   let W = ex1 - ex0, H = ey1 - ey0;
   let cut = function( a )
   {
      let o = new Float32Array( W * H );
      for ( let y = 0; y < H; ++y )
         o.set( a.subarray( ( ey0 + y ) * d.W + ex0, ( ey0 + y ) * d.W + ex1 ), y * W );
      return o;
   };
   d.crop = {
      x0: x0, y0: y0, cw: cw, ch: ch, ex0: ex0, ey0: ey0, W: W, H: H,
      target: d.target.map( cut ),
      lines: d.lines.map( function( l ) { return { key: l.key, data: cut( l.data ) }; } )
   };
   return d.crop;
};

NBADD.previewBitmap = function( d, p, showOriginal, useCrop )
{
   if ( useCrop && d.crop )
   {
      let c = d.crop;
      let full = showOriginal ? c.target : NBADD.apply( c.target, c.lines, p, NBADD.context( d, c.W, c.H, 1 ) );
      let ox = c.x0 - c.ex0, oy = c.y0 - c.ey0;
      let inner = full.map( function( a )
      {
         let o = new Float32Array( c.cw * c.ch );
         for ( let y = 0; y < c.ch; ++y )
            o.set( a.subarray( ( oy + y ) * c.W + ox, ( oy + y ) * c.W + ox + c.cw ), y * c.cw );
         return o;
      } );
      return CT.renderBitmap( inner, c.cw, c.ch, d.preview.stretch );
   }
   let pv = d.preview;
   let ch = showOriginal ? pv.target : NBADD.apply( pv.target, pv.lines, p, NBADD.context( d, pv.W, pv.H, pv.f ) );
   return CT.renderBitmap( ch, pv.W, pv.H, pv.stretch );
};
