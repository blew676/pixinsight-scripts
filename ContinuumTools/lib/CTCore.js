// ----------------------------------------------------------------------------
// ContinuumTools - shared core library
// ----------------------------------------------------------------------------
//
// Used by NarrowbandContinuumSubtraction, BroadbandLineRemoval and
// StarHoleRepair. Everything lives in the CT namespace object so the scripts
// can be re-run in PixInsight's persistent V8 runtime without redeclaration
// errors (classes are assigned as properties, never declared at top level).
//
// Pixel data is handled as Float32Array buffers normalized to [0,1], one
// buffer per channel, row-major (index = y*width + x).
// ----------------------------------------------------------------------------

var CT = {};

CT.VERSION = "1.1.0";
CT.SETTINGS_ROOT = "ContinuumTools";

// ----------------------------------------------------------------------------
// Logging / progress
// ----------------------------------------------------------------------------

CT.log  = function( s ) { console.writeln( s ); };
CT.note = function( s ) { console.noteln( s ); };
CT.warn = function( s ) { console.warningln( s ); };

CT.yieldUI = function()
{
   try { CoreApplication.processEvents(); } catch ( e ) {}
};

CT.checkAbort = function()
{
   CT.yieldUI();
   if ( console.abortRequested )
      throw new Error( "Aborted by user" );
};

CT.fmt = function( v, d )
{
   if ( v === undefined || v === null || !isFinite( v ) )
      return "n/a";
   return Number( v ).toFixed( d === undefined ? 4 : d );
};

CT.errorBox = function( msg, title )
{
   console.criticalln( "*** " + msg );
   try
   {
      ( new MessageBox( msg, title || "ContinuumTools", StdIcon.Error, StdButton.Ok ) ).execute();
   }
   catch ( e ) {}
};

CT.infoBox = function( msg, title )
{
   try
   {
      ( new MessageBox( msg, title || "ContinuumTools", StdIcon.Information, StdButton.Ok ) ).execute();
   }
   catch ( e ) {}
};

// ----------------------------------------------------------------------------
// Views and windows
// ----------------------------------------------------------------------------

CT.isView = function( v )
{
   try
   {
      return v !== null && v !== undefined && v.isView && !v.isNull;
   }
   catch ( e )
   {
      return false;
   }
};

CT.viewExists = function( id )
{
   try
   {
      let v = View.viewById( id );
      return v !== null && v !== undefined && !v.isNull;
   }
   catch ( e )
   {
      return false;
   }
};

CT.safeId = function( s )
{
   let id = String( s ).replace( /[^A-Za-z0-9_]/g, "_" );
   if ( id.length == 0 || /^[0-9]/.test( id ) )
      id = "_" + id;
   return id;
};

CT.uniqueId = function( base )
{
   let id = CT.safeId( base );
   if ( !CT.viewExists( id ) )
      return id;
   for ( let i = 1; ; ++i )
      if ( !CT.viewExists( id + i ) )
         return id + i;
};

CT.geometry = function( view )
{
   let img = view.image;
   return { W: img.width, H: img.height, C: img.numberOfChannels, color: img.isColor };
};

CT.requireSameGeometry = function( a, b, what )
{
   let ga = CT.geometry( a ), gb = CT.geometry( b );
   if ( ga.W != gb.W || ga.H != gb.H )
      throw new Error( what + ": image sizes differ (" + a.id + " is " + ga.W + "x" + ga.H +
                       ", " + b.id + " is " + gb.W + "x" + gb.H + "). The images must be registered " +
                       "to each other and cropped identically." );
};

// One channel of a view as normalized Float32Array.
CT.getChannel = function( view, ch )
{
   let img = view.image;
   let a = new Float32Array( img.width * img.height );
   img.getSamples( a, new Rect, ch || 0 );
   return a;
};

CT.getChannels = function( view )
{
   let out = [];
   for ( let c = 0; c < view.image.numberOfChannels; ++c )
      out.push( CT.getChannel( view, c ) );
   return out;
};

// Mean of the nominal channels (used for detection on color images).
CT.getLuminance = function( view )
{
   let img = view.image;
   if ( img.numberOfChannels == 1 )
      return CT.getChannel( view, 0 );
   let n = img.width * img.height, nc = Math.min( 3, img.numberOfChannels );
   let acc = new Float32Array( n );
   for ( let c = 0; c < nc; ++c )
   {
      let a = CT.getChannel( view, c );
      for ( let i = 0; i < n; ++i )
         acc[i] += a[i];
   }
   for ( let i = 0; i < n; ++i )
      acc[i] /= nc;
   return acc;
};

CT.windowIdSet = function()
{
   let ids = {};
   let windows = ImageWindow.windows;
   for ( let i = 0; i < windows.length; ++i )
      ids[ windows[i].mainView.id ] = true;
   return ids;
};

CT.findNewWindow = function( idsBefore, preferredPrefix )
{
   let candidate = null;
   let windows = ImageWindow.windows;
   for ( let i = 0; i < windows.length; ++i )
   {
      let w = windows[i];
      let id = w.mainView.id;
      if ( idsBefore[ id ] )
         continue;
      if ( preferredPrefix && id.indexOf( preferredPrefix ) == 0 )
         return w;
      candidate = w;
   }
   return candidate;
};

// Creates a 32-bit float window from one (gray) or three (RGB) channel buffers.
// Values are clipped to [0,1].
CT.createWindow = function( id, W, H, channels, opts )
{
   opts = opts || {};
   let nc = channels.length;
   let win = new ImageWindow( W, H, nc, 32, true, nc >= 3, CT.uniqueId( id ) );
   let view = win.mainView;
   view.beginProcess( UndoFlag.NoSwapFile );
   for ( let c = 0; c < nc; ++c )
   {
      let a = channels[c];
      for ( let i = 0, n = a.length; i < n; ++i )
      {
         let v = a[i];
         if ( !( v > 0 ) ) a[i] = 0; else if ( v > 1 ) a[i] = 1;
      }
      view.image.setSamples( a, new Rect, c );
   }
   view.endProcess();
   if ( CT.isView( opts.keywordsFrom ) )
   {
      try
      {
         let kw = opts.keywordsFrom.window.keywords;
         if ( opts.history )
            for ( let i = 0; i < opts.history.length; ++i )
               kw.push( new FITSKeyword( "HISTORY", "", opts.history[i] ) );
         win.keywords = kw;
      }
      catch ( e ) {}
      try { win.copyAstrometricSolution( opts.keywordsFrom.window ); } catch ( e ) {}
   }
   if ( opts.show !== false )
   {
      win.show();
      win.zoomToFit();
   }
   return win;
};

// Writes channel buffers back into an existing view (undoable).
CT.writeToView = function( view, channels )
{
   view.beginProcess( UndoFlag.PixelData );
   try
   {
      for ( let c = 0; c < channels.length; ++c )
      {
         let a = channels[c];
         for ( let i = 0, n = a.length; i < n; ++i )
         {
            let v = a[i];
            if ( !( v > 0 ) ) a[i] = 0; else if ( v > 1 ) a[i] = 1;
         }
         view.image.setSamples( a, new Rect, c );
      }
   }
   finally
   {
      view.endProcess();
   }
};

// Reads a numeric FITS keyword (first match among names), or null.
CT.keywordNumber = function( view, names )
{
   if ( !CT.isView( view ) )
      return null;
   try
   {
      let kw = view.window.keywords;
      for ( let n = 0; n < names.length; ++n )
         for ( let i = 0; i < kw.length; ++i )
            if ( kw[i].name.trim().toUpperCase() == names[n] )
            {
               let v = parseFloat( String( kw[i].value ).replace( /'/g, "" ) );
               if ( isFinite( v ) )
                  return v;
            }
   }
   catch ( e ) {}
   return null;
};

CT.exposureOf = function( view )
{
   return CT.keywordNumber( view, [ "EXPTIME", "EXPOSURE" ] );
};

// ----------------------------------------------------------------------------
// StarXTerminator
// ----------------------------------------------------------------------------

CT.hasStarX = function()
{
   return typeof StarXTerminator != "undefined";
};

// Runs StarXTerminator on a hidden float copy of srcView. The source view is
// never modified. Returns { window, stars } where stars is the stars-only
// window when opts.stars is true.
CT.runStarX = function( srcView, opts )
{
   opts = opts || {};
   if ( !CT.hasStarX() )
      throw new Error( "StarXTerminator is not installed. Select starless images manually, " +
                       "or install the RC Astro StarXTerminator module." );
   let g = CT.geometry( srcView );
   let id = CT.uniqueId( opts.id || ( srcView.id + "_starless" ) );
   let win = new ImageWindow( g.W, g.H, g.C, 32, true, g.color, id );
   win.mainView.beginProcess( UndoFlag.NoSwapFile );
   for ( let c = 0; c < g.C; ++c )
      win.mainView.image.setSamples( CT.getChannel( srcView, c ), new Rect, c );
   win.mainView.endProcess();
   try { win.keywords = srcView.window.keywords; } catch ( e ) {}
   try { win.copyAstrometricSolution( srcView.window ); } catch ( e ) {}

   CT.note( "StarXTerminator: removing stars from a copy of " + srcView.id + " ..." );
   CT.yieldUI();
   let before = CT.windowIdSet();
   let P = new StarXTerminator;   // picks up the user's last-used model/overlap
   P.remove_stars = true;
   P.output_stars = !!opts.stars;
   P.unscreen = false;
   let t0 = Date.now();
   if ( !P.executeOn( win.mainView, false ) )
   {
      win.forceClose();
      throw new Error( "StarXTerminator failed on " + srcView.id );
   }
   CT.log( format( "StarXTerminator done in %.1f s", ( Date.now() - t0 ) / 1000 ) );
   let stars = null;
   if ( opts.stars )
      stars = CT.findNewWindow( before, id + "_stars" );
   else
   {
      // Close anything StarX may have produced anyway.
      let w = CT.findNewWindow( before, id + "_stars" );
      if ( w != null && !w.isNull )
         w.forceClose();
   }
   return { window: win, stars: stars };
};

// ----------------------------------------------------------------------------
// Statistics
// ----------------------------------------------------------------------------

// Sorted subsample (at most maxN values) of a buffer.
CT.sortedSample = function( a, maxN )
{
   maxN = maxN || 500000;
   let step = Math.max( 1, Math.floor( a.length / maxN ) );
   // odd stride so the sample does not alias with image rows
   if ( step > 1 && step % 2 == 0 ) step += 1;
   let n = Math.ceil( a.length / step );
   let s = new Float32Array( n );
   for ( let i = 0, j = 0; j < n; i += step, ++j )
      s[j] = a[i];
   s.sort();
   return s;
};

CT.quantileSorted = function( s, p )
{
   if ( s.length == 0 )
      return 0;
   let i = Math.min( s.length - 1, Math.max( 0, Math.floor( p * ( s.length - 1 ) ) ) );
   return s[i];
};

CT.robustStats = function( a )
{
   let s = CT.sortedSample( a );
   let med = CT.quantileSorted( s, 0.5 );
   let d = new Float32Array( s.length );
   for ( let i = 0; i < s.length; ++i )
      d[i] = Math.abs( s[i] - med );
   d.sort();
   let mad = CT.quantileSorted( d, 0.5 );
   return {
      median: med, mad: mad, sigma: 1.4826 * mad,
      min: s[0], max: s[s.length - 1],
      p0001: CT.quantileSorted( s, 0.0001 ), p001: CT.quantileSorted( s, 0.001 ),
      p01: CT.quantileSorted( s, 0.01 ), p05: CT.quantileSorted( s, 0.05 ),
      p95: CT.quantileSorted( s, 0.95 ), p99: CT.quantileSorted( s, 0.99 ),
      p999: CT.quantileSorted( s, 0.999 )
   };
};

CT.median = function( arr )
{
   if ( arr.length == 0 )
      return 0;
   let s = Float64Array.from( arr );
   s.sort();
   return s[ s.length >> 1 ];
};

CT.quantile = function( arr, p )
{
   if ( arr.length == 0 )
      return 0;
   let s = Float64Array.from( arr );
   s.sort();
   return CT.quantileSorted( s, p );
};

// Pixel-scale noise estimate, robust against large-scale structure and less
// sensitive to 16-bit quantization than plain first differences:
// d = a - mean(4 neighbours), var(d) = 1.25 sigma^2  =>  sigma = 1.4826 MAD(d) / sqrt(1.25)
// Clipped (zero) pixels are ignored.
CT.noiseSigma = function( a, W, H )
{
   let d = [];
   let step = Math.max( 1, Math.floor( a.length / 400000 ) ) | 1;
   for ( let i = W + 1; i < a.length - W - 1; i += step )
   {
      let x = i % W;
      if ( x == 0 || x == W - 1 )
         continue;
      let v = a[i];
      if ( v <= 0 )
         continue;
      d.push( v - 0.25 * ( a[i - 1] + a[i + 1] + a[i - W] + a[i + W] ) );
   }
   let med = CT.median( d );
   for ( let i = 0; i < d.length; ++i )
      d[i] = Math.abs( d[i] - med );
   return 1.4826 * CT.median( d ) / Math.sqrt( 1.25 );
};

// Coarse background map: median of each block, bilinear lookup.
CT.backgroundMap = function( a, W, H, block )
{
   block = block || 64;
   let bw = Math.ceil( W / block ), bh = Math.ceil( H / block );
   let vals = new Float32Array( bw * bh );
   let buf = new Float32Array( block * block );
   for ( let by = 0; by < bh; ++by )
      for ( let bx = 0; bx < bw; ++bx )
      {
         let n = 0;
         let y1 = Math.min( H, ( by + 1 ) * block ), x1 = Math.min( W, ( bx + 1 ) * block );
         for ( let y = by * block; y < y1; y += 2 )
            for ( let x = bx * block; x < x1; x += 2 )
               buf[n++] = a[y * W + x];
         let s = buf.subarray( 0, n );
         s.sort();
         // 40th percentile: biased slightly low so stars do not raise it
         vals[by * bw + bx] = s[ Math.floor( 0.4 * ( n - 1 ) ) ];
      }
   return { bw: bw, bh: bh, block: block, vals: vals };
};

CT.bgAt = function( map, x, y )
{
   let fx = x / map.block - 0.5, fy = y / map.block - 0.5;
   let x0 = Math.floor( fx ), y0 = Math.floor( fy );
   let tx = fx - x0, ty = fy - y0;
   let cx = function( v ) { return Math.max( 0, Math.min( map.bw - 1, v ) ); };
   let cy = function( v ) { return Math.max( 0, Math.min( map.bh - 1, v ) ); };
   let v00 = map.vals[ cy( y0 ) * map.bw + cx( x0 ) ], v10 = map.vals[ cy( y0 ) * map.bw + cx( x0 + 1 ) ];
   let v01 = map.vals[ cy( y0 + 1 ) * map.bw + cx( x0 ) ], v11 = map.vals[ cy( y0 + 1 ) * map.bw + cx( x0 + 1 ) ];
   return ( v00 * ( 1 - tx ) + v10 * tx ) * ( 1 - ty ) + ( v01 * ( 1 - tx ) + v11 * tx ) * ty;
};

// ----------------------------------------------------------------------------
// Filters (pure JS, Float32Array in/out)
// ----------------------------------------------------------------------------

// Running max (isMax) or min over a (2r+1) square window, separable,
// van Herk / Gil-Werman: O(1) per pixel regardless of r.
CT.rankFilter = function( src, W, H, r, isMax )
{
   let tmp = new Float32Array( W * H ), dst = new Float32Array( W * H );
   let n = 2 * r + 1;
   let pad = isMax ? -Infinity : Infinity;
   let maxLen = Math.max( W, H ) + 2 * r + n;
   let g = new Float32Array( maxLen ), h = new Float32Array( maxLen ), line = new Float32Array( maxLen );
   let pass = function( inp, out, len, count, stride, step )
   {
      let L2 = len + 2 * r;
      for ( let c = 0; c < count; ++c )
      {
         let base = c * stride;
         for ( let i = 0; i < L2; ++i )
         {
            let j = i - r;
            line[i] = ( j < 0 || j >= len ) ? pad : inp[base + j * step];
         }
         if ( isMax )
         {
            for ( let i = 0; i < L2; ++i )
               g[i] = ( i % n == 0 ) ? line[i] : Math.max( g[i - 1], line[i] );
            for ( let i = L2 - 1; i >= 0; --i )
               h[i] = ( i % n == n - 1 || i == L2 - 1 ) ? line[i] : Math.max( h[i + 1], line[i] );
            for ( let j = 0; j < len; ++j )
               out[base + j * step] = Math.max( h[j], g[j + 2 * r] );
         }
         else
         {
            for ( let i = 0; i < L2; ++i )
               g[i] = ( i % n == 0 ) ? line[i] : Math.min( g[i - 1], line[i] );
            for ( let i = L2 - 1; i >= 0; --i )
               h[i] = ( i % n == n - 1 || i == L2 - 1 ) ? line[i] : Math.min( h[i + 1], line[i] );
            for ( let j = 0; j < len; ++j )
               out[base + j * step] = Math.min( h[j], g[j + 2 * r] );
         }
      }
   };
   pass( src, tmp, W, H, W, 1 );
   CT.yieldUI();
   pass( tmp, dst, H, W, 1, W );
   return dst;
};

// Morphological closing (dilate then erode): fills dark features smaller
// than the window.
CT.closing = function( a, W, H, r )
{
   let d = CT.rankFilter( a, W, H, r, true );
   return CT.rankFilter( d, W, H, r, false );
};

// Box blur with radius r (separable, edge-clamped), any size.
CT.boxBlur = function( src, W, H, r )
{
   let tmp = new Float32Array( W * H ), dst = new Float32Array( W * H );
   let norm = 1 / ( 2 * r + 1 );
   for ( let y = 0; y < H; ++y )
   {
      let row = y * W, s = 0;
      for ( let k = -r; k <= r; ++k )
         s += src[row + Math.min( W - 1, Math.max( 0, k ) )];
      for ( let x = 0; x < W; ++x )
      {
         tmp[row + x] = s * norm;
         s += src[row + Math.min( W - 1, x + r + 1 )] - src[row + Math.max( 0, x - r )];
      }
   }
   for ( let x = 0; x < W; ++x )
   {
      let s = 0;
      for ( let k = -r; k <= r; ++k )
         s += tmp[Math.min( H - 1, Math.max( 0, k ) ) * W + x];
      for ( let y = 0; y < H; ++y )
      {
         dst[y * W + x] = s * norm;
         s += tmp[Math.min( H - 1, y + r + 1 ) * W + x] - tmp[Math.max( 0, y - r ) * W + x];
      }
   }
   return dst;
};

// Integer box downsample by factor f (block average).
CT.downsample = function( a, W, H, f )
{
   if ( f <= 1 )
      return { a: a, W: W, H: H };
   let w = Math.floor( W / f ), h = Math.floor( H / f );
   let out = new Float32Array( w * h );
   let inv = 1 / ( f * f );
   for ( let y = 0; y < h; ++y )
      for ( let x = 0; x < w; ++x )
      {
         let s = 0;
         for ( let dy = 0; dy < f; ++dy )
         {
            let row = ( y * f + dy ) * W + x * f;
            for ( let dx = 0; dx < f; ++dx )
               s += a[row + dx];
         }
         out[y * w + x] = s * inv;
      }
   return { a: out, W: w, H: h };
};

// Block-median downsample (rejects stars), factor f.
CT.downsampleMedian = function( a, W, H, f )
{
   let w = Math.floor( W / f ), h = Math.floor( H / f );
   let out = new Float32Array( w * h );
   let buf = new Float32Array( f * f );
   for ( let y = 0; y < h; ++y )
   {
      for ( let x = 0; x < w; ++x )
      {
         let n = 0;
         for ( let dy = 0; dy < f; ++dy )
         {
            let row = ( y * f + dy ) * W + x * f;
            for ( let dx = 0; dx < f; ++dx )
               buf[n++] = a[row + dx];
         }
         buf.sort();
         out[y * w + x] = buf[ n >> 1 ];
      }
      if ( ( y & 63 ) == 0 )
         CT.yieldUI();
   }
   return { a: out, W: w, H: h };
};

// Push-pull (multiresolution) interpolation of unknown pixels.
// vals: Float32Array w*h, known: Float32Array weights in [0,1] (1 = known).
// Returns a new Float32Array with unknown pixels filled smoothly.
CT.pushPull = function( vals, known, w, h )
{
   let levels = [];
   let v = new Float32Array( w * h ), wt = new Float32Array( w * h );
   for ( let i = 0; i < w * h; ++i )
   {
      wt[i] = Math.max( 0, Math.min( 1, known[i] ) );
      v[i] = vals[i];
   }
   levels.push( { v: v, wt: wt, w: w, h: h } );
   // pull
   for ( ;; )
   {
      let L = levels[ levels.length - 1 ];
      let missing = false;
      for ( let i = 0; i < L.w * L.h; ++i )
         if ( L.wt[i] < 1e-6 ) { missing = true; break; }
      if ( !missing || ( L.w <= 1 && L.h <= 1 ) )
         break;
      let nw = Math.max( 1, Math.ceil( L.w / 2 ) ), nh = Math.max( 1, Math.ceil( L.h / 2 ) );
      let nv = new Float32Array( nw * nh ), nwt = new Float32Array( nw * nh );
      for ( let y = 0; y < nh; ++y )
         for ( let x = 0; x < nw; ++x )
         {
            let sv = 0, sw = 0;
            for ( let dy = 0; dy < 2; ++dy )
               for ( let dx = 0; dx < 2; ++dx )
               {
                  let xx = 2 * x + dx, yy = 2 * y + dy;
                  if ( xx >= L.w || yy >= L.h )
                     continue;
                  let k = yy * L.w + xx;
                  sv += L.v[k] * L.wt[k];
                  sw += L.wt[k];
               }
            nv[y * nw + x] = sw > 0 ? sv / sw : 0;
            nwt[y * nw + x] = Math.min( 1, sw );
         }
      levels.push( { v: nv, wt: nwt, w: nw, h: nh } );
   }
   // push
   for ( let l = levels.length - 2; l >= 0; --l )
   {
      let L = levels[l], C = levels[l + 1];
      for ( let y = 0; y < L.h; ++y )
         for ( let x = 0; x < L.w; ++x )
         {
            let k = y * L.w + x;
            if ( L.wt[k] >= 1 )
               continue;
            // bilinear sample of the coarse level at (x/2, y/2)
            let fx = Math.min( C.w - 1, Math.max( 0, ( x + 0.5 ) / 2 - 0.5 ) );
            let fy = Math.min( C.h - 1, Math.max( 0, ( y + 0.5 ) / 2 - 0.5 ) );
            let x0 = Math.floor( fx ), y0 = Math.floor( fy );
            let x1 = Math.min( C.w - 1, x0 + 1 ), y1 = Math.min( C.h - 1, y0 + 1 );
            let tx = fx - x0, ty = fy - y0;
            let c = ( C.v[y0 * C.w + x0] * ( 1 - tx ) + C.v[y0 * C.w + x1] * tx ) * ( 1 - ty ) +
                    ( C.v[y1 * C.w + x0] * ( 1 - tx ) + C.v[y1 * C.w + x1] * tx ) * ty;
            L.v[k] = L.wt[k] * L.v[k] + ( 1 - L.wt[k] ) * c;
            L.wt[k] = 1;
         }
   }
   return levels[0].v;
};

// Harmonic (membrane) refinement of a filled region: successive
// over-relaxation of Laplace's equation on pixels with known < 0.5, starting
// from the current values (normally a push-pull result).
CT.relaxLaplace = function( v, known, w, h, iterations )
{
   let idx = [];
   for ( let y = 1; y < h - 1; ++y )
      for ( let x = 1; x < w - 1; ++x )
         if ( known[y * w + x] < 0.5 )
            idx.push( y * w + x );
   let omega = 1.85;
   for ( let it = 0; it < ( iterations || 80 ); ++it )
      for ( let j = 0; j < idx.length; ++j )
      {
         let i = idx[j];
         let target = 0.25 * ( v[i - 1] + v[i + 1] + v[i - w] + v[i + w] );
         v[i] += omega * ( target - v[i] );
      }
   return v;
};

// Weighted least squares y = a + b*x. Returns {a, b, n}.
CT.linearFit = function( xs, ys, ws )
{
   let n = xs.length, sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
   for ( let i = 0; i < n; ++i )
   {
      let w = ws ? ws[i] : 1;
      sw += w; sx += w * xs[i]; sy += w * ys[i];
      sxx += w * xs[i] * xs[i]; sxy += w * xs[i] * ys[i];
   }
   if ( sw <= 0 )
      return { a: 0, b: 0, n: 0 };
   let mx = sx / sw, my = sy / sw;
   let vxx = sxx / sw - mx * mx, vxy = sxy / sw - mx * my;
   let b = vxx > 1e-30 ? vxy / vxx : 0;
   return { a: my - b * mx, b: b, n: n };
};

// ----------------------------------------------------------------------------
// Stars: detection and aperture photometry
// ----------------------------------------------------------------------------

// Local maxima above bg + k*sigma. Returns arrays {x, y, peak, n}.
CT.detectStars = function( a, W, H, opts )
{
   opts = opts || {};
   let sigma = opts.sigma || CT.noiseSigma( a, W, H );
   let k = opts.k || 12;
   let border = opts.border || 8;
   let rad = opts.radius || 2;
   let bg = opts.bgMap || CT.backgroundMap( a, W, H, 64 );
   let minBg = Infinity;
   for ( let i = 0; i < bg.vals.length; ++i )
      if ( bg.vals[i] < minBg ) minBg = bg.vals[i];
   let quick = minBg + k * sigma;
   let xs = [], ys = [], ps = [];
   for ( let y = border; y < H - border; ++y )
   {
      let row = y * W;
      for ( let x = border; x < W - border; ++x )
      {
         let v = a[row + x];
         if ( v < quick )
            continue;
         let b = CT.bgAt( bg, x, y );
         if ( v < b + k * sigma )
            continue;
         let isMax = true;
         for ( let dy = -rad; dy <= rad && isMax; ++dy )
         {
            let r2 = row + dy * W + x;
            for ( let dx = -rad; dx <= rad; ++dx )
            {
               if ( dx == 0 && dy == 0 )
                  continue;
               let u = a[r2 + dx];
               // strict on one half to break ties on flat (saturated) tops
               if ( u > v || ( u == v && ( dy < 0 || ( dy == 0 && dx < 0 ) ) ) )
               {
                  isMax = false;
                  break;
               }
            }
         }
         if ( !isMax )
            continue;
         xs.push( x ); ys.push( y ); ps.push( v - b );
      }
      if ( ( y & 255 ) == 0 )
         CT.yieldUI();
   }
   return { x: xs, y: ys, peak: ps, n: xs.length, sigma: sigma };
};

// Aperture photometry at integer (x, y). Returns null if out of bounds.
CT.photometry = function( a, W, H, x, y, rAp, rIn, rOut, sat )
{
   let R = Math.ceil( rOut );
   if ( x - R < 0 || y - R < 0 || x + R >= W || y + R >= H )
      return null;
   let ann = [];
   let rAp2 = rAp * rAp, rIn2 = rIn * rIn, rOut2 = rOut * rOut;
   for ( let dy = -R; dy <= R; ++dy )
      for ( let dx = -R; dx <= R; ++dx )
      {
         let r2 = dx * dx + dy * dy;
         if ( r2 > rIn2 && r2 <= rOut2 )
            ann.push( a[( y + dy ) * W + x + dx] );
      }
   let bg = CT.median( ann );
   let f = 0, n = 0, sxx = 0, mx = -Infinity, saturated = false;
   let Ra = Math.ceil( rAp );
   for ( let dy = -Ra; dy <= Ra; ++dy )
      for ( let dx = -Ra; dx <= Ra; ++dx )
      {
         let r2 = dx * dx + dy * dy;
         if ( r2 > rAp2 )
            continue;
         let raw = a[( y + dy ) * W + x + dx];
         if ( raw >= sat )
            saturated = true;
         let v = raw - bg;
         f += v; ++n;
         if ( v > mx ) mx = v;
         if ( v > 0 )
            sxx += v * r2;
      }
   let fpos = 0;
   for ( let dy = -Ra; dy <= Ra; ++dy )
      for ( let dx = -Ra; dx <= Ra; ++dx )
      {
         if ( dx * dx + dy * dy > rAp2 )
            continue;
         let v = a[( y + dy ) * W + x + dx] - bg;
         if ( v > 0 )
            fpos += v;
      }
   let fwhm = fpos > 0 ? 2.3548 * Math.sqrt( sxx / ( 2 * fpos ) ) : 0;
   return { flux: f, bg: bg, peak: mx, n: n, fwhm: fwhm, saturated: saturated };
};

// Measures the continuum scale factor k = flux(NB)/flux(BB) from isolated,
// unsaturated stars. Stars are pure continuum, so this is the amount of the
// broadband image that has to be subtracted from the narrowband image.
CT.measureContinuumRatio = function( nb, bb, W, H, opts )
{
   opts = opts || {};
   let kDetect = opts.k || 20;
   let sNB = CT.robustStats( nb ), sBB = CT.robustStats( bb );
   let satNB = sNB.max >= 0.9 ? 0.98 * sNB.max : Infinity;
   let satBB = sBB.max >= 0.9 ? 0.98 * sBB.max : Infinity;
   let sigBB = CT.noiseSigma( bb, W, H );
   let sigNB = CT.noiseSigma( nb, W, H );
   CT.log( format( "Star measurement: noise NB %.3e, BB %.3e", sigNB, sigBB ) );

   // All detections (moderate threshold) for isolation tests, bright ones for photometry.
   let bgMap = CT.backgroundMap( bb, W, H, 64 );
   let all = CT.detectStars( bb, W, H, { sigma: sigBB, k: 10, bgMap: bgMap, border: 20 } );
   CT.log( "Star measurement: " + all.n + " detections in the continuum image" );
   if ( all.n < 10 )
      throw new Error( "Too few stars were detected in the continuum image. The scale factor " +
                       "must be measured on images WITH stars (the starless versions are only " +
                       "used for the subtraction)." );

   // spatial hash for neighbour checks
   let cell = 24, gw = Math.ceil( W / cell ), gh = Math.ceil( H / cell );
   let grid = new Array( gw * gh );
   for ( let i = 0; i < all.n; ++i )
   {
      let g = Math.floor( all.y[i] / cell ) * gw + Math.floor( all.x[i] / cell );
      if ( !grid[g] ) grid[g] = [];
      grid[g].push( i );
   }
   let isolated = function( i, dist )
   {
      let x = all.x[i], y = all.y[i], d2 = dist * dist;
      let gx = Math.floor( x / cell ), gy = Math.floor( y / cell ), rr = Math.ceil( dist / cell );
      for ( let yy = gy - rr; yy <= gy + rr; ++yy )
         for ( let xx = gx - rr; xx <= gx + rr; ++xx )
         {
            if ( xx < 0 || yy < 0 || xx >= gw || yy >= gh )
               continue;
            let list = grid[yy * gw + xx];
            if ( !list )
               continue;
            for ( let j = 0; j < list.length; ++j )
            {
               let o = list[j];
               if ( o == i )
                  continue;
               let dx = all.x[o] - x, dy = all.y[o] - y;
               if ( dx * dx + dy * dy < d2 )
                  return false;
            }
         }
      return true;
   };

   // candidates: bright, unsaturated detections
   let cand = [];
   for ( let i = 0; i < all.n; ++i )
      if ( all.peak[i] > kDetect * sigBB )
         cand.push( i );
   cand.sort( function( i, j ) { return all.peak[j] - all.peak[i]; } );

   // FWHM from the brightest isolated stars sets the aperture size
   let fw = [];
   for ( let c = 0; c < cand.length && fw.length < 300; ++c )
   {
      let i = cand[c];
      if ( !isolated( i, 20 ) )
         continue;
      let p = CT.photometry( bb, W, H, all.x[i], all.y[i], 8, 11, 15, satBB );
      if ( p != null && !p.saturated && p.fwhm > 0.5 )
         fw.push( p.fwhm );
   }
   // A compact aperture keeps nebula structure (noise for this purpose) out of
   // the flux sums; the ratio is insensitive to the small fraction of flux lost.
   let fwhm = fw.length > 5 ? CT.median( fw ) : 4;
   let rAp = Math.max( 4, Math.min( 20, 1.4 * fwhm ) );
   let rIn = rAp + 2, rOut = rIn + Math.max( 3, 0.4 * rAp );
   CT.log( format( "Star measurement: FWHM %.2f px, aperture %.1f px, annulus %.1f-%.1f px", fwhm, rAp, rIn, rOut ) );

   let ratios = [], fwN = [], fwB = [], xs = [], ys = [], fN = [], fB = [];
   let snrMin = opts.snrMin || 100;
   for ( let c = 0; c < cand.length; ++c )
   {
      let i = cand[c];
      if ( !isolated( i, rIn + 1 ) )
         continue;
      let pb = CT.photometry( bb, W, H, all.x[i], all.y[i], rAp, rIn, rOut, satBB );
      if ( pb == null || pb.saturated || !( pb.flux > 0 ) )
         continue;
      let snr = pb.flux / ( sigBB * Math.sqrt( pb.n ) );
      if ( snr < snrMin )
         continue;
      let pn = CT.photometry( nb, W, H, all.x[i], all.y[i], rAp, rIn, rOut, satNB );
      if ( pn == null || pn.saturated )
         continue;
      ratios.push( pn.flux / pb.flux );
      fN.push( pn.flux ); fB.push( pb.flux );
      fwB.push( pb.fwhm ); fwN.push( pn.fwhm );
      xs.push( all.x[i] ); ys.push( all.y[i] );
      if ( ( c & 127 ) == 0 )
         CT.yieldUI();
   }
   if ( ratios.length < 10 )
      throw new Error( "Only " + ratios.length + " usable stars were found. Use images with stars " +
                       "for the measurement, or enter the scale factor manually." );
   let k = CT.median( ratios );
   // flux-weighted ratio over the central 80% of stars (cross-check)
   let lo = CT.quantile( ratios, 0.1 ), hi = CT.quantile( ratios, 0.9 ), sn = 0, sb = 0;
   for ( let i = 0; i < ratios.length; ++i )
      if ( ratios[i] >= lo && ratios[i] <= hi ) { sn += fN[i]; sb += fB[i]; }
   let res = {
      k: k,
      kWeighted: sb > 0 ? sn / sb : k,
      p10: CT.quantile( ratios, 0.10 ), p25: CT.quantile( ratios, 0.25 ),
      p75: CT.quantile( ratios, 0.75 ), p90: CT.quantile( ratios, 0.90 ),
      n: ratios.length, fwhmBB: CT.median( fwB ), fwhmNB: CT.median( fwN ),
      rAp: rAp, bgBB: sBB.median, bgNB: sNB.median
   };
   CT.note( "Continuum scale factor k = " + CT.fmt( res.k ) + "  (middle half of stars: " +
            CT.fmt( res.p25 ) + " - " + CT.fmt( res.p75 ) + ", " + res.n + " stars)" );
   CT.log( format( "Star FWHM: narrowband %.2f px, continuum %.2f px", res.fwhmNB, res.fwhmBB ) );
   return res;
};

// ----------------------------------------------------------------------------
// Display stretch and preview rendering
// ----------------------------------------------------------------------------

CT.mtf = function( m, x )
{
   if ( x <= 0 ) return 0;
   if ( x >= 1 ) return 1;
   return ( ( m - 1 ) * x ) / ( ( 2 * m - 1 ) * x - m );
};

// PixInsight-style AutoSTF parameters from a buffer.
CT.autoStretch = function( a, targetBkg, shadowsClip )
{
   let st = CT.robustStats( a );
   let sigma = st.sigma > 0 ? st.sigma : 1e-6;
   let c0 = Math.max( 0, st.median - ( shadowsClip || 2.8 ) * sigma );
   let x = ( st.median - c0 ) / ( 1 - c0 );
   let m = CT.mtf( targetBkg || 0.25, x );
   if ( !( m > 0 && m < 1 ) )
      m = 0.5;
   return { c0: c0, m: m };
};

CT.applyStretch = function( v, s )
{
   return CT.mtf( s.m, ( v - s.c0 ) / ( 1 - s.c0 ) );
};

// Renders 1 or 3 channel buffers (w*h) as a Bitmap through per-channel stretches.
CT.renderBitmap = function( channels, w, h, stretches )
{
   let nc = channels.length >= 3 ? 3 : 1;
   let img = new Image( w, h, nc, nc == 3 ? ColorSpace.RGB : ColorSpace.Gray );
   let buf = new Float32Array( w * h );
   for ( let c = 0; c < nc; ++c )
   {
      let a = channels[c], s = stretches[ Math.min( c, stretches.length - 1 ) ];
      let c0 = s.c0, m = s.m, inv = 1 / ( 1 - c0 );
      for ( let i = 0; i < w * h; ++i )
      {
         let x = ( a[i] - c0 ) * inv;
         buf[i] = x <= 0 ? 0 : x >= 1 ? 1 : ( ( m - 1 ) * x ) / ( ( 2 * m - 1 ) * x - m );
      }
      img.setSamples( buf, new Rect, c );
   }
   let bmp = img.render();
   img.free();
   return bmp;
};

CT.previewFactor = function( W, H, maxW, maxH )
{
   return Math.max( 1, Math.ceil( Math.max( W / ( maxW || 1600 ), H / ( maxH || 1100 ) ) ) );
};

// ----------------------------------------------------------------------------
// Preview control: zoom (wheel), pan (drag), fit (double click), click
// callback in image coordinates, overlay callback in bitmap coordinates.
// ----------------------------------------------------------------------------

CT.PreviewControl = class extends Control
{
   constructor( parent )
   {
      super( parent );
      this.bitmap = null;
      this.scale = 1;          // image pixels per bitmap pixel
      this.zoom = 1;
      this.ox = 0; this.oy = 0;   // bitmap coords at the top-left of the control
      this.dragging = false;
      this.moved = false;
      this.lastX = 0; this.lastY = 0;
      this.needsFit = true;
      this.onImageClick = null;   // function( xImage, yImage )
      this.overlay = null;        // function( graphics, control )
      this.message = "Preview";
      this.setScaledMinSize( 560, 420 );
      try { this.cursor = new Cursor( StdCursor.Cross ); } catch ( e ) {}
      this.toolTip = "<p>Mouse wheel: zoom. Drag: pan. Double click: fit to window.</p>";

      this.onPaint = ( x0, y0, x1, y1 ) =>
      {
         let g = new Graphics( this );
         try
         {
            g.fillRect( x0, y0, x1, y1, new Brush( 0xff1e1e1e ) );
            if ( this.bitmap )
            {
               if ( this.needsFit )
                  this.fitNow();
               g.scaleTransformation( this.zoom );
               g.translateTransformation( -this.ox, -this.oy );
               g.drawBitmap( 0, 0, this.bitmap );
               if ( this.overlay )
                  this.overlay( g, this );
            }
            else
            {
               g.pen = new Pen( 0xffa0a0a0 );
               g.drawTextRect( 0, 0, this.width, this.height, this.message,
                               TextAlignment.HorzCenter | TextAlignment.VertCenter );
            }
         }
         finally
         {
            g.end();
         }
      };

      this.onMousePress = ( x, y, button, buttons, modifiers ) =>
      {
         this.dragging = true;
         this.moved = false;
         this.lastX = x; this.lastY = y;
      };

      this.onMouseMove = ( x, y, buttons, modifiers ) =>
      {
         if ( !this.dragging || !this.bitmap )
            return;
         let dx = x - this.lastX, dy = y - this.lastY;
         if ( Math.abs( dx ) + Math.abs( dy ) > 2 )
            this.moved = true;
         if ( this.moved )
         {
            this.ox -= dx / this.zoom;
            this.oy -= dy / this.zoom;
            this.lastX = x; this.lastY = y;
            this.repaint();
         }
      };

      this.onMouseRelease = ( x, y, button, buttons, modifiers ) =>
      {
         let wasClick = this.dragging && !this.moved;
         this.dragging = false;
         if ( wasClick && this.bitmap && this.onImageClick )
         {
            let p = this.toImage( x, y );
            this.onImageClick( p.x, p.y );
         }
      };

      this.onMouseWheel = ( x, y, delta, buttons, modifiers ) =>
      {
         if ( !this.bitmap )
            return;
         let bx = x / this.zoom + this.ox, by = y / this.zoom + this.oy;
         let z = delta > 0 ? this.zoom * 1.25 : this.zoom / 1.25;
         z = Math.max( 0.05, Math.min( 16, z ) );
         this.zoom = z;
         this.ox = bx - x / z;
         this.oy = by - y / z;
         this.repaint();
      };

      this.onMouseDoubleClick = ( x, y, buttons, modifiers ) =>
      {
         this.fit();
      };

      this.onResize = ( w, h, ow, oh ) =>
      {
         if ( this.bitmap && this.needsFit )
            this.repaint();
      };
   }

   // Image coords -> bitmap coords and back
   toImage( sx, sy )
   {
      return { x: ( sx / this.zoom + this.ox ) * this.scale, y: ( sy / this.zoom + this.oy ) * this.scale };
   }

   setBitmap( bmp, scale, keepView )
   {
      let first = !this.bitmap;
      this.bitmap = bmp;
      this.scale = scale || 1;
      if ( first || !keepView )
         this.needsFit = true;
      this.repaint();
   }

   clear( message )
   {
      this.bitmap = null;
      if ( message )
         this.message = message;
      this.repaint();
   }

   fitNow()
   {
      if ( !this.bitmap || this.width < 2 || this.height < 2 )
         return;
      let bw = this.bitmap.width, bh = this.bitmap.height;
      let z = Math.min( this.width / bw, this.height / bh );
      this.zoom = z;
      this.ox = ( bw - this.width / z ) / 2;
      this.oy = ( bh - this.height / z ) / 2;
      this.needsFit = false;
   }

   fit()
   {
      this.needsFit = true;
      this.repaint();
   }
};

// ----------------------------------------------------------------------------
// Small UI helpers
// ----------------------------------------------------------------------------

CT.ui = {};

CT.ui.label = function( parent, text, minWidth, tip )
{
   let l = new Label( parent );
   l.text = text;
   l.textAlignment = TextAlignment.Right | TextAlignment.VertCenter;
   if ( minWidth ) l.minWidth = minWidth;
   if ( tip ) l.toolTip = tip;
   return l;
};

CT.ui.infoLabel = function( parent, text )
{
   let l = new Label( parent );
   l.text = text || "";
   l.wordWrapping = true;
   l.useRichText = true;
   return l;
};

CT.ui.numeric = function( parent, text, labelWidth, min, max, precision, value, onChange, tip )
{
   let n = new NumericControl( parent );
   n.label.text = text;
   if ( labelWidth ) n.label.minWidth = labelWidth;
   n.setRange( min, max );
   n.slider.setRange( 0, 1000 );
   n.slider.setScaledMinWidth( 160 );
   n.setPrecision( precision );
   n.setValue( value );
   if ( tip ) n.toolTip = tip;
   n.onValueUpdated = function( v ) { onChange( v ); };
   return n;
};

CT.ui.button = function( parent, text, onClick, tip )
{
   let b = new PushButton( parent );
   b.text = text;
   if ( tip ) b.toolTip = tip;
   b.onClick = function() { onClick(); };
   return b;
};

CT.ui.check = function( parent, text, checked, onClick, tip )
{
   let c = new CheckBox( parent );
   c.text = text;
   c.checked = !!checked;
   if ( tip ) c.toolTip = tip;
   c.onClick = function( v ) { onClick( v ); };
   return c;
};

CT.ui.viewList = function( parent, tip, onSelected )
{
   let v = new ViewList( parent );
   v.getMainViews();
   if ( tip ) v.toolTip = tip;
   if ( onSelected ) v.onViewSelected = function( view ) { onSelected( view ); };
   return v;
};

CT.ui.row = function( items, spacing )
{
   let s = new HorizontalSizer;
   s.spacing = spacing === undefined ? 4 : spacing;
   for ( let i = 0; i < items.length; ++i )
   {
      if ( items[i] === "stretch" )
         s.addStretch();
      else
         s.add( items[i] );
   }
   return s;
};

CT.ui.group = function( parent, title, items )
{
   let g = new GroupBox( parent );
   g.title = title;
   g.sizer = new VerticalSizer;
   g.sizer.margin = 6;
   g.sizer.spacing = 4;
   for ( let i = 0; i < items.length; ++i )
      g.sizer.add( items[i] );
   return g;
};

CT.ui.labeledRow = function( parent, text, labelWidth, control, tip )
{
   let l = CT.ui.label( parent, text, labelWidth, tip );
   let s = new HorizontalSizer;
   s.spacing = 4;
   s.add( l );
   s.add( control, 100 );
   return s;
};

// ----------------------------------------------------------------------------
// Persistent settings (per-tool key/value store)
// ----------------------------------------------------------------------------

CT.loadSettings = function( tool, obj )
{
   for ( let key in obj )
   {
      let v = obj[key];
      let type = typeof v == "number" ? DataType.Double : typeof v == "boolean" ? DataType.Boolean :
                 typeof v == "string" ? DataType.String : null;
      if ( type === null )
         continue;
      try
      {
         let r = Settings.read( CT.SETTINGS_ROOT + "/" + tool + "/" + key, type );
         if ( Settings.lastReadOK && r !== null && r !== undefined )
            obj[key] = r;
      }
      catch ( e ) {}
   }
   return obj;
};

CT.saveSettings = function( tool, obj )
{
   for ( let key in obj )
   {
      let v = obj[key];
      let type = typeof v == "number" ? DataType.Double : typeof v == "boolean" ? DataType.Boolean :
                 typeof v == "string" ? DataType.String : null;
      if ( type === null )
         continue;
      try { Settings.write( CT.SETTINGS_ROOT + "/" + tool + "/" + key, type, v ); } catch ( e ) {}
   }
};
