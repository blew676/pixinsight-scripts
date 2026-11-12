// ----------------------------------------------------------------------------
// ContinuumTools - star hole detection and repair engine
// ----------------------------------------------------------------------------
//
// Finds dark, compact "holes" left where stars were over-subtracted, and
// fills them from their surroundings.
//
// Detection
//   1. Morphological closing (max then min filter) of the image fills every
//      dark feature narrower than the window; closing - image (black top-hat)
//      is large inside holes.
//   2. Pixels deeper than threshold*noise and darker than (1-depth) of their
//      local level become candidates; candidates are grouped into blobs.
//   3. Blobs are kept if compact and roughly round, and - when a star
//      reference image is given - only if a star sits inside them. That last
//      test is what separates star holes from real dark nebula knots.
//
// Repair (per hole, per channel, inside a small local window)
//   Guided:  target ~ a + b*guide fitted in a ring around the hole, applied
//            inside, plus a smooth correction of the residual so the edge is
//            seamless. The guide (normally a starless narrowband image)
//            supplies the real nebula structure under the star.
//   Smooth:  push-pull + harmonic interpolation from the surroundings, plus
//            high-frequency texture borrowed from a nearby clean patch (or
//            matched synthetic noise), similar to a healing brush.
//   The fill is feathered into the original over a few pixels.
// ----------------------------------------------------------------------------

var CTRepair = {};

CTRepair.defaults = function()
{
   return {
      maxRadius: 50,      // largest hole radius searched (px)
      threshold: 8,       // detection threshold (noise sigmas)
      depth: 0.40,        // minimum relative depth below the local level
      contrast: 0.50,     // minimum hole depth as a fraction of (median - floor)
      coreLevel: 0.25,    // hole core must reach within this fraction of the black floor (1 = off)
      starScale: 5,       // star peak (noise sigmas) must exceed starScale * r^2 (0 = off)
      minArea: 6,         // smallest blob kept (px)
      maxAspect: 2.2,     // bounding-box aspect ratio limit
      minFill: 0.30,      // blob area / bounding-box area (star-gated; stricter without a reference)
      requireStar: true,  // keep only holes with a star in the reference
      starSigma: 12,      // star detection threshold in the reference
      growPx: 3,          // repair radius = r*(1+growFrac) + growPx
      growFrac: 0.35,
      feather: 3,         // blend width (px)
      texture: true       // add texture/noise to smooth fills
   };
};

// Deterministic PRNG + normal deviates (repeatable results)
CTRepair.rng = function( seed )
{
   let s = seed >>> 0;
   let uniform = function()
   {
      s = ( s + 0x6D2B79F5 ) >>> 0;
      let t = s;
      t = Math.imul( t ^ ( t >>> 15 ), t | 1 );
      t ^= t + Math.imul( t ^ ( t >>> 7 ), t | 61 );
      return ( ( t ^ ( t >>> 14 ) ) >>> 0 ) / 4294967296;
   };
   let spare = null;
   return {
      uniform: uniform,
      normal: function()
      {
         if ( spare !== null ) { let v = spare; spare = null; return v; }
         let u = 0, v = 0;
         while ( u <= 1e-12 ) u = uniform();
         v = uniform();
         let m = Math.sqrt( -2 * Math.log( u ) );
         spare = m * Math.sin( 2 * Math.PI * v );
         return m * Math.cos( 2 * Math.PI * v );
      }
   };
};

// ----------------------------------------------------------------------------
// Detection
// ----------------------------------------------------------------------------

// lum: Float32Array (detection image), ref: Float32Array star reference or null.
// Returns { blobs, cand, W, H, sigma, floor, nStars }.
CTRepair.detect = function( lum, W, H, ref, p )
{
   p = p || CTRepair.defaults();
   let N = W * H;
   let t0 = Date.now();
   let sigma = CT.noiseSigma( lum, W, H );
   let st = CT.robustStats( lum );
   let floor = st.p0001;
   let T = Math.max( p.threshold * sigma, 1e-7 );
   CT.log( format( "Hole detection: noise %.3e, floor %.4f, threshold %.3e", sigma, floor, T ) );

   let r = Math.max( 2, Math.round( p.maxRadius ) );
   let clo = CT.closing( lum, W, H, r );
   CT.checkAbort();
   let cand = new Uint8Array( N );
   let depth = p.depth;
   for ( let i = 0; i < N; ++i )
   {
      let c = clo[i], th = c - lum[i];
      if ( th > T && th > depth * ( c - floor ) )
         cand[i] = 1;
   }
   // Absolute contrast a hole needs to be visible / worth repairing.
   let minContrast = Math.max( T, ( p.contrast === undefined ? 0.3 : p.contrast ) * ( st.median - floor ) );

   // 8-connected labelling
   let label = new Int32Array( N );
   let stack = new Int32Array( N );
   let blobs = [];
   for ( let i = 0; i < N; ++i )
   {
      if ( !cand[i] || label[i] )
         continue;
      let id = blobs.length + 1;
      let sp = 0;
      stack[sp++] = i;
      label[i] = id;
      let area = 0, sx = 0, sy = 0, x0 = W, x1 = -1, y0 = H, y1 = -1, minv = Infinity, maxDepth = 0;
      while ( sp > 0 )
      {
         let q = stack[--sp];
         let x = q % W, y = ( q - x ) / W;
         ++area; sx += x; sy += y;
         if ( x < x0 ) x0 = x; if ( x > x1 ) x1 = x;
         if ( y < y0 ) y0 = y; if ( y > y1 ) y1 = y;
         if ( lum[q] < minv ) minv = lum[q];
         let dq = clo[q] - lum[q];
         if ( dq > maxDepth ) maxDepth = dq;
         for ( let dy = -1; dy <= 1; ++dy )
         {
            let yy = y + dy;
            if ( yy < 0 || yy >= H )
               continue;
            for ( let dx = -1; dx <= 1; ++dx )
            {
               let xx = x + dx;
               if ( xx < 0 || xx >= W )
                  continue;
               let o = yy * W + xx;
               if ( cand[o] && !label[o] )
               {
                  label[o] = id;
                  stack[sp++] = o;
               }
            }
         }
      }
      blobs.push( { id: id, area: area, cx: sx / area, cy: sy / area, x0: x0, x1: x1, y0: y0, y1: y1,
                    minv: minv, depth: maxDepth, core: 0, level: 0 } );
      if ( ( blobs.length & 1023 ) == 0 )
         CT.checkAbort();
   }
   stack = null;
   // Second pass: fraction of each blob that is "deep" (sharp-edged, clipped
   // holes have a high core fraction; diffuse dark nebulae taper off), and
   // the local level around the darkest point.
   for ( let i = 0; i < N; ++i )
   {
      let id = label[i];
      if ( id == 0 )
         continue;
      let b = blobs[id - 1];
      let d = clo[i] - lum[i];
      if ( d > 0.6 * b.depth )
         ++b.core;
      if ( d >= b.depth )
         b.level = clo[i];
   }
   for ( let b of blobs )
   {
      b.coreFrac = b.core / b.area;
      b.minRel = b.level > floor ? ( b.minv - floor ) / ( b.level - floor ) : 1;
   }
   label = null;
   clo = null;
   CT.log( "Hole detection: " + blobs.length + " dark candidate regions" );

   // shape filter
   let strict = !ref || !p.requireStar;
   // Without a star reference the shape is the only evidence, so be strict.
   let maxAspect = strict ? Math.min( p.maxAspect, 1.6 ) : p.maxAspect;
   let minFill = strict ? Math.max( p.minFill, 0.6 ) : p.minFill;
   let maxSize = 2 * p.maxRadius + 1;
   let kept = [];
   for ( let b of blobs )
   {
      let bw = b.x1 - b.x0 + 1, bh = b.y1 - b.y0 + 1;
      let aspect = Math.max( bw, bh ) / Math.min( bw, bh );
      let fill = b.area / ( bw * bh );
      b.aspect = aspect; b.fill = fill;
      b.reason = b.area < p.minArea ? "small" : aspect > maxAspect ? "aspect" : fill < minFill ? "fill" :
                 Math.max( bw, bh ) > maxSize ? "size" : b.depth < minContrast ? "contrast" :
                 b.minRel > ( p.coreLevel === undefined ? 1 : p.coreLevel ) ? "shallow" : "";
      if ( b.reason != "" )
         continue;
      b.r = 0.5 * Math.max( bw, bh );
      b.hasStar = false;
      kept.push( b );
   }

   // star gating
   let nStars = 0;
   if ( ref )
   {
      let stars = CT.detectStars( ref, W, H, { k: p.starSigma, border: 2 } );
      nStars = stars.n;
      CT.log( "Hole detection: " + stars.n + " stars in the reference image" );
      let cell = 32, gw = Math.ceil( W / cell ), gh = Math.ceil( H / cell );
      let grid = new Array( gw * gh );
      for ( let i = 0; i < stars.n; ++i )
      {
         let g = Math.floor( stars.y[i] / cell ) * gw + Math.floor( stars.x[i] / cell );
         if ( !grid[g] ) grid[g] = [];
         grid[g].push( i );
      }
      // The star must sit near the centre of the hole (a hole is the
      // over-subtracted image of that star); chance coincidences with the
      // dense field of faint stars fail this test.
      for ( let b of kept )
      {
         let m = Math.max( 3, 0.5 * b.r );
         let bx0 = b.cx - m, bx1 = b.cx + m, by0 = b.cy - m, by1 = b.cy + m;
         let gx0 = Math.max( 0, Math.floor( bx0 / cell ) ), gx1 = Math.min( gw - 1, Math.floor( bx1 / cell ) );
         let gy0 = Math.max( 0, Math.floor( by0 / cell ) ), gy1 = Math.min( gh - 1, Math.floor( by1 / cell ) );
         b.starPeak = 0;
         for ( let gy = gy0; gy <= gy1; ++gy )
            for ( let gx = gx0; gx <= gx1; ++gx )
            {
               let list = grid[gy * gw + gx];
               if ( !list )
                  continue;
               for ( let j = 0; j < list.length; ++j )
               {
                  let s = list[j];
                  if ( stars.x[s] >= bx0 && stars.x[s] <= bx1 && stars.y[s] >= by0 && stars.y[s] <= by1 )
                  {
                     b.hasStar = true;
                     let pk = stars.peak[s] / stars.sigma;
                     if ( !( b.starPeak > pk ) ) b.starPeak = pk;
                  }
               }
            }
      }
   }
   // A hole's size scales with the brightness of the star that caused it:
   // big dark regions next to faint stars are nebulae, not holes.
   let starScale = p.starScale || 0;
   for ( let b of kept )
   {
      b.bright = !ref || starScale <= 0 || ( b.starPeak || 0 ) >= starScale * b.r * b.r;
      b.accepted = ( ref && p.requireStar ) ? ( b.hasStar && b.bright ) : true;
   }

   let nAcc = 0;
   for ( let b of kept ) if ( b.accepted ) ++nAcc;
   CT.note( format( "Hole detection: %d holes to repair, %d candidates rejected (%.1f s)",
                    nAcc, kept.length - nAcc, ( Date.now() - t0 ) / 1000 ) );
   return { blobs: kept, all: p.debug ? blobs : null, cand: cand, W: W, H: H,
            sigma: sigma, floor: floor, nStars: nStars };
};

CTRepair.repairRadius = function( b, p )
{
   return b.r * ( 1 + p.growFrac ) + p.growPx;
};

// ----------------------------------------------------------------------------
// Repair
// ----------------------------------------------------------------------------

// Robust linear fit ys ~ a + b*xs (two passes, 3-sigma rejection).
CTRepair.robustFit = function( xs, ys )
{
   let f = CT.linearFit( xs, ys );
   let res = new Float64Array( xs.length );
   for ( let i = 0; i < xs.length; ++i )
      res[i] = Math.abs( ys[i] - ( f.a + f.b * xs[i] ) );
   let s = 1.4826 * CT.median( res ) + 1e-12;
   let wx = [], wy = [];
   for ( let i = 0; i < xs.length; ++i )
      if ( res[i] < 3 * s ) { wx.push( xs[i] ); wy.push( ys[i] ); }
   if ( wx.length >= 8 )
      f = CT.linearFit( wx, wy );
   if ( f.b < 0 )
   {
      // a negative slope means the guide does not describe the target here:
      // fall back to a constant level
      f = { a: CT.median( ys ), b: 0, n: ys.length };
   }
   return f;
};

// Robust sigma of the high-frequency part (pixel - 3x3 mean) of a window,
// over the pixels flagged in sel.
CTRepair.hfSigma = function( v, w, h, sel )
{
   let d = [];
   for ( let y = 1; y < h - 1; ++y )
      for ( let x = 1; x < w - 1; ++x )
      {
         let i = y * w + x;
         if ( !sel[i] )
            continue;
         let m = ( v[i - w - 1] + v[i - w] + v[i - w + 1] + v[i - 1] + v[i] + v[i + 1] + v[i + w - 1] + v[i + w] + v[i + w + 1] ) / 9;
         d.push( v[i] - m );
      }
   if ( d.length < 8 )
      return 0;
   let med = CT.median( d );
   for ( let i = 0; i < d.length; ++i ) d[i] = Math.abs( d[i] - med );
   return 1.4826 * CT.median( d ) / 0.943;   // 0.943: HF filter gain for white noise
};

// Repairs all accepted blobs.
//   channels: array of Float32Array (modified copies are returned)
//   det: result of CTRepair.detect
//   guide: array of Float32Array (one per channel, or a single one), or null
// Returns { channels, mask, repaired }.
CTRepair.repair = function( channels, det, guide, p )
{
   p = p || CTRepair.defaults();
   let W = det.W, H = det.H, N = W * H;
   let out = channels.map( function( a ) { return Float32Array.from( a ); } );
   let mask = new Float32Array( N );
   let done = new Uint8Array( N );
   let cand = det.cand;
   let rng = CTRepair.rng( 12345 );
   let t0 = Date.now(), count = 0;

   let list = det.blobs.filter( function( b ) { return b.accepted; } );
   for ( let bi = 0; bi < list.length; ++bi )
   {
      let b = list[bi];
      let R = CTRepair.repairRadius( b, p );
      let F = Math.max( 0.5, p.feather );
      let ring = Math.max( 6, 0.6 * R );
      let M = Math.ceil( R + F + ring + 2 );
      let x0 = Math.max( 0, Math.floor( b.cx - M ) ), x1 = Math.min( W - 1, Math.ceil( b.cx + M ) );
      let y0 = Math.max( 0, Math.floor( b.cy - M ) ), y1 = Math.min( H - 1, Math.ceil( b.cy + M ) );
      let w = x1 - x0 + 1, h = y1 - y0 + 1, n = w * h;
      if ( w < 5 || h < 5 )
         continue;

      // pixel roles inside the window
      let wgt = new Float32Array( n );      // blend weight of the fill
      let known = new Float32Array( n );    // 1 = valid data for interpolation
      let fitSel = new Uint8Array( n );     // ring used for fitting/statistics
      let fillSel = new Uint8Array( n );    // pixels where a fill value is needed
      let nFit = 0;
      for ( let y = 0; y < h; ++y )
         for ( let x = 0; x < w; ++x )
         {
            let i = y * w + x, gi = ( y0 + y ) * W + x0 + x;
            let dx = x0 + x - b.cx, dy = y0 + y - b.cy;
            let d = Math.sqrt( dx * dx + dy * dy );
            let otherHole = cand[gi] && !done[gi];
            if ( d <= R )
               wgt[i] = 1;
            else if ( d <= R + F )
            {
               let t = 1 - ( d - R ) / F;
               wgt[i] = t * t * ( 3 - 2 * t );
            }
            if ( wgt[i] > 0 || otherHole )
               fillSel[i] = 1;
            else
               known[i] = 1;
            if ( d > R + F && d <= R + F + ring && !otherHole )
            {
               fitSel[i] = 1;
               ++nFit;
            }
         }
      if ( nFit < 12 )
         continue;

      for ( let c = 0; c < out.length; ++c )
      {
         let img = out[c];
         let t = new Float32Array( n );
         for ( let y = 0; y < h; ++y )
            t.set( img.subarray( ( y0 + y ) * W + x0, ( y0 + y ) * W + x0 + w ), y * w );

         let fill;
         let gsrc = guide ? guide[ Math.min( c, guide.length - 1 ) ] : null;
         if ( gsrc )
         {
            let g = new Float32Array( n );
            for ( let y = 0; y < h; ++y )
               g.set( gsrc.subarray( ( y0 + y ) * W + x0, ( y0 + y ) * W + x0 + w ), y * w );
            let xs = [], ys = [];
            for ( let i = 0; i < n; ++i )
               if ( fitSel[i] ) { xs.push( g[i] ); ys.push( t[i] ); }
            let f = CTRepair.robustFit( xs, ys );
            // The guide supplies mid-scale structure only; its own pixel noise
            // (often raw, un-denoised data) is removed with a small blur and
            // the texture is taken from the target itself below.
            let base = new Float32Array( n );
            for ( let i = 0; i < n; ++i )
               base[i] = f.a + f.b * g[i];
            base = CT.boxBlur( base, w, h, 2 );
            let res = new Float32Array( n );
            for ( let i = 0; i < n; ++i )
               res[i] = known[i] ? t[i] - base[i] : 0;
            let rf = CT.pushPull( res, known, w, h );
            CT.relaxLaplace( rf, known, w, h, Math.min( 150, 30 + 2 * R ) );
            fill = new Float32Array( n );
            for ( let i = 0; i < n; ++i )
               fill[i] = base[i] + rf[i];
         }
         else
         {
            fill = CT.pushPull( t, known, w, h );
            CT.relaxLaplace( fill, known, w, h, Math.min( 150, 30 + 2 * R ) );
         }
         if ( p.texture )
            CTRepair.addTexture( fill, t, img, W, H, x0, y0, w, h, fillSel, fitSel, b, R + F, cand, done, rng );

         for ( let y = 0; y < h; ++y )
            for ( let x = 0; x < w; ++x )
            {
               let i = y * w + x;
               let a = wgt[i];
               if ( a <= 0 )
                  continue;
               let gi = ( y0 + y ) * W + x0 + x;
               img[gi] = t[i] * ( 1 - a ) + fill[i] * a;
            }
      }
      for ( let y = 0; y < h; ++y )
         for ( let x = 0; x < w; ++x )
         {
            let i = y * w + x, gi = ( y0 + y ) * W + x0 + x;
            if ( wgt[i] > mask[gi] ) mask[gi] = wgt[i];
            if ( wgt[i] >= 0.5 ) done[gi] = 1;
         }
      ++count;
      if ( ( bi & 63 ) == 0 )
         CT.checkAbort();
   }
   CT.note( format( "Repaired %d holes in %.1f s", count, ( Date.now() - t0 ) / 1000 ) );
   return { channels: out, mask: mask, repaired: count };
};

// Adds high-frequency texture to a smooth fill: borrowed from the cleanest
// nearby patch of similar brightness, or synthetic noise when none is found.
CTRepair.addTexture = function( fill, t, img, W, H, x0, y0, w, h, fillSel, fitSel, b, Rf, cand, done, rng )
{
   let n = w * h;
   let sigT = CTRepair.hfSigma( t, w, h, fitSel );
   if ( !( sigT > 0 ) )
      return;
   let ringMean = 0, nr = 0;
   for ( let i = 0; i < n; ++i )
      if ( fitSel[i] ) { ringMean += t[i]; ++nr; }
   ringMean /= Math.max( 1, nr );

   let best = null;
   let D = 2 * Rf + 4;
   for ( let s = 0; s < 2; ++s )
   {
      let dist = s == 0 ? D : 1.6 * D;
      for ( let k = 0; k < 8; ++k )
      {
         let ang = k * Math.PI / 4;
         let ox = Math.round( dist * Math.cos( ang ) ), oy = Math.round( dist * Math.sin( ang ) );
         let dx0 = x0 + ox, dy0 = y0 + oy;
         if ( dx0 < 0 || dy0 < 0 || dx0 + w > W || dy0 + h > H )
            continue;
         let bad = 0, sum = 0, cnt = 0, vmin = Infinity, vmax = -Infinity;
         for ( let y = 0; y < h; ++y )
            for ( let x = 0; x < w; ++x )
            {
               let i = y * w + x;
               if ( !fillSel[i] )
                  continue;
               let gi = ( dy0 + y ) * W + dx0 + x;
               if ( cand[gi] && !done[gi] ) ++bad;
               let v = img[gi];
               sum += v; ++cnt;
               if ( v < vmin ) vmin = v;
               if ( v > vmax ) vmax = v;
            }
         if ( cnt == 0 || bad > 0.02 * cnt )
            continue;
         // reject donors containing stars or other strong features
         let mean = sum / cnt;
         if ( vmax - mean > 10 * sigT || mean - vmin > 10 * sigT )
            continue;
         let score = Math.abs( sum / cnt - ringMean );
         if ( best === null || score < best.score )
            best = { ox: ox, oy: oy, score: score };
      }
      if ( best !== null )
         break;
   }

   if ( best !== null )
   {
      let patch = new Float32Array( n );
      for ( let y = 0; y < h; ++y )
         patch.set( img.subarray( ( y0 + best.oy + y ) * W + x0 + best.ox, ( y0 + best.oy + y ) * W + x0 + best.ox + w ), y * w );
      let blur = CT.boxBlur( patch, w, h, 2 );
      let hf = new Float32Array( n );
      for ( let i = 0; i < n; ++i )
         hf[i] = patch[i] - blur[i];
      let sel = new Uint8Array( n );
      for ( let i = 0; i < n; ++i ) sel[i] = 1;
      let sigP = CTRepair.hfSigma( patch, w, h, sel );
      let gain = sigP > 0 ? Math.max( 0.5, Math.min( 2, sigT / sigP ) ) : 1;
      for ( let i = 0; i < n; ++i )
         if ( fillSel[i] ) fill[i] += gain * hf[i];
   }
   else
   {
      for ( let i = 0; i < n; ++i )
         if ( fillSel[i] ) fill[i] += sigT * rng.normal();
   }
};
