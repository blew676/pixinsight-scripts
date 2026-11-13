// Headless test of the Luminance and Detail controls of Add Narrowband to RGB.
//  - Luminance must brighten without the red shift the colour weights give.
//  - Detail must remove noise where H-alpha is strong, keep stars (absent from
//    the narrowband image), and move the image closer to the clean truth.
#engine v8
#include "../lib/CTCore.js"
#include "../lib/NBAddEngine.js"
#include "../lib/NBAddDialog.js"
#include "TestUtil.js"

T.rng = function( seed )
{
   let s = seed >>> 0, spare = null;
   let u = function() { s = ( Math.imul( s, 1664525 ) + 1013904223 ) >>> 0; return ( s + 0.5 ) / 4294967296; };
   return { u: u, n: function()
   {
      if ( spare !== null ) { let v = spare; spare = null; return v; }
      let a = u(), b = u(), m = Math.sqrt( -2 * Math.log( a ) );
      spare = m * Math.sin( 2 * Math.PI * b );
      return m * Math.cos( 2 * Math.PI * b );
   } };
};

T.run( "nbadd_lum", function()
{
   CT.errorBox = function( m ) { T.log( "ERRORBOX: " + m ); };
   let nbv = T.open( T.DATA + "NB_ha.tif" );
   nbv.id = "NBha";
   let g = CT.geometry( nbv ), W = g.W, H = g.H, N = W * H;
   let nb = CT.getChannel( nbv, 0 );

   // truth: an H-alpha-shaped nebula with a warm tint, plus stars the
   // narrowband image does not have
   let truth = [ 1.0, 0.85, 0.75 ].map( k => { let a = new Float32Array( N ); for ( let i = 0; i < N; ++i ) a[i] = 0.08 + 0.8 * k * nb[i]; return a; } );
   let rng = T.rng( 7 ), stars = [];
   for ( let s = 0; s < 400; ++s )
   {
      let x = 20 + Math.floor( rng.u() * ( W - 40 ) ), y = 20 + Math.floor( rng.u() * ( H - 40 ) ), amp = 0.25 + 0.5 * rng.u();
      stars.push( { x: x, y: y } );
      for ( let dy = -8; dy <= 8; ++dy ) for ( let dx = -8; dx <= 8; ++dx )
      {
         let v = amp * Math.exp( -( dx * dx + dy * dy ) / ( 2 * 1.6 * 1.6 ) );
         for ( let c = 0; c < 3; ++c ) { let i = ( y + dy ) * W + x + dx; truth[c][i] = Math.min( 1, truth[c][i] + v ); }
      }
   }
   let noisy = truth.map( a => { let o = new Float32Array( N ); for ( let i = 0; i < N; ++i ) o[i] = Math.max( 0, Math.min( 1, a[i] + 0.02 * rng.n() ) ); return o; } );
   let tw = CT.createWindow( "T_noisy", W, H, noisy.map( a => Float32Array.from( a ) ), { show: false } ).mainView;

   let t0 = Date.now();
   let d = NBADD.load( tw, { ha: nbv } );
   T.log( "load " + ( ( Date.now() - t0 ) / 1000 ).toFixed( 1 ) + " s, sigmaL " + d.sigmaL.toExponential( 2 ) +
          ", ha stats " + JSON.stringify( d.lineStats.ha ) );
   let ctx = NBADD.context( d, W, H, 1 );

   // strong-H-alpha region used for the metrics (same rule as the detail mask's top end)
   let strong = new Uint8Array( N );
   for ( let i = 0; i < N; ++i ) if ( nb[i] > d.lineStats.ha.hi ) strong[i] = 1;
   let starMask = new Uint8Array( N );
   for ( let s of stars ) for ( let dy = -6; dy <= 6; ++dy ) for ( let dx = -6; dx <= 6; ++dx ) starMask[( s.y + dy ) * W + s.x + dx] = 1;
   let rms = function( out )
   {
      let se = 0, n = 0;
      for ( let i = 0; i < N; ++i ) if ( strong[i] && !starMask[i] ) { for ( let c = 0; c < 3; ++c ) { let e = out[c][i] - truth[c][i]; se += e * e; } n += 3; }
      return Math.sqrt( se / n );
   };
   let lightness = function( ch )
   {
      let img = new Image( W, H, 3, ColorSpace.RGB );
      for ( let c = 0; c < 3; ++c ) img.setSamples( ch[c], new Rect, c );
      let Li = new Image; img.getLightness( Li );
      let L = new Float32Array( N ); Li.getSamples( L, new Rect, 0 ); Li.free(); img.free();
      return L;
   };
   let Ltruth = lightness( truth );
   let rmsL = function( out )
   {
      let L = lightness( out ), se = 0, n = 0;
      for ( let i = 0; i < N; ++i ) if ( strong[i] && !starMask[i] ) { let e = L[i] - Ltruth[i]; se += e * e; ++n; }
      return Math.sqrt( se / n );
   };
   let starPeaks = function( out )
   {
      let r = 0, n = 0;
      for ( let s of stars ) { let i = s.y * W + s.x; if ( !strong[i] ) continue; r += out[0][i] / truth[0][i]; ++n; }
      return { mean: r / n, n: n };
   };
   let redness = function( out )
   {
      let s = 0, n = 0;
      for ( let i = 0; i < N; i += 13 ) if ( strong[i] && !starMask[i] ) { let t = out[0][i] + out[1][i] + out[2][i]; if ( t > 0 ) { s += out[0][i] / t; ++n; } }
      return s / n;
   };
   let meanL = function( out )
   {
      let s = 0, n = 0;
      for ( let i = 0; i < N; i += 13 ) if ( strong[i] && !starMask[i] ) { s += ( out[0][i] + out[1][i] + out[2][i] ) / 3; ++n; }
      return s / n;
   };

   T.log( "noisy:  rms vs truth (strong Ha, no stars) " + rms( noisy ).toFixed( 5 ) + ", star peaks/truth " +
          starPeaks( noisy ).mean.toFixed( 3 ) + ", redness " + redness( noisy ).toFixed( 4 ) + ", mean " + meanL( noisy ).toFixed( 4 ) );

   // Luminance only (no colour) vs colour only
   let pc = NBADD.defaults();                                    // colour: R 1.0, G 0, B 0.05
   let oc = NBADD.apply( d.target, d.lines, pc, ctx );
   let pl = NBADD.defaults(); pl.ha_r = pl.ha_g = pl.ha_b = 0; pl.ha_lum = 1;
   t0 = Date.now();
   let ol = NBADD.apply( d.target, d.lines, pl, ctx );
   T.log( "luminance step " + ( ( Date.now() - t0 ) / 1000 ).toFixed( 1 ) + " s" );
   T.log( "colour 1.0/0/0.05:  mean " + meanL( oc ).toFixed( 4 ) + ", redness " + redness( oc ).toFixed( 4 ) );
   T.log( "luminance 1, no colour: mean " + meanL( ol ).toFixed( 4 ) + ", redness " + redness( ol ).toFixed( 4 ) );

   // Detail only
   let pd = NBADD.defaults(); pd.ha_r = pd.ha_g = pd.ha_b = 0; pd.ha_detail = 1;
   t0 = Date.now();
   let od = NBADD.apply( d.target, d.lines, pd, ctx );
   T.log( "detail step " + ( ( Date.now() - t0 ) / 1000 ).toFixed( 1 ) + " s" );
   T.log( "lightness rms vs truth: noisy " + rmsL( noisy ).toFixed( 5 ) );
   T.log( "detail 1:  lightness rms " + rmsL( od ).toFixed( 5 ) + ", per-channel rms " + rms( od ).toFixed( 5 ) +
          ", star peaks/truth " + starPeaks( od ).mean.toFixed( 3 ) + " (" + starPeaks( od ).n + " stars in strong Ha), redness " +
          redness( od ).toFixed( 4 ) );
   for ( let r of [ 2, 5 ] )
   {
      let pr = NBADD.defaults(); pr.ha_r = pr.ha_g = pr.ha_b = 0; pr.ha_detail = 1; pr.detailRadius = r;
      T.log( "detail 1, radius " + r + ": lightness rms " + rmsL( NBADD.apply( d.target, d.lines, pr, ctx ) ).toFixed( 5 ) );
   }
   let pd2 = NBADD.defaults(); pd2.ha_r = pd2.ha_g = pd2.ha_b = 0; pd2.ha_detail = 0.5;
   T.log( "detail 0.5: lightness rms " + rmsL( NBADD.apply( d.target, d.lines, pd2, ctx ) ).toFixed( 5 ) );

   // crops for a look: noisy | detail 1 | truth, around the brightest Ha
   let bx = 0, bv = -1;
   for ( let i = 0; i < N; i += 101 ) if ( nb[i] > bv ) { bv = nb[i]; bx = i; }
   let cx = Math.min( W - 200, Math.max( 200, bx % W ) ), cy = Math.min( H - 150, Math.max( 150, Math.floor( bx / W ) ) );
   let crop = function( a ) { let o = new Float32Array( 400 * 300 ); for ( let y = 0; y < 300; ++y ) o.set( a.subarray( ( cy - 150 + y ) * W + cx - 200, ( cy - 150 + y ) * W + cx + 200 ), y * 400 ); return o; };
   let id = { c0: 0, m: 0.5 };
   let strip = new Bitmap( 1200, 300 );
   let gr = new Graphics( strip );
   gr.drawBitmap( 0, 0, CT.renderBitmap( noisy.map( crop ), 400, 300, [ id ] ) );
   gr.drawBitmap( 400, 0, CT.renderBitmap( od.map( crop ), 400, 300, [ id ] ) );
   gr.drawBitmap( 800, 0, CT.renderBitmap( truth.map( crop ), 400, 300, [ id ] ) );
   gr.end();
   strip.save( T.OUT + "/nbadd_detail_crops.png" );

   // dialog: sliders, 1:1 crop by click, run
   let dlg = new NBAddDialog();
   dlg.targetList.currentView = tw;
   dlg.lineUI.ha.list.currentView = nbv;
   dlg.inputsChanged();
   dlg.doPreview();
   dlg.p.ha_lum = 0.5; dlg.p.ha_detail = 1; dlg.lineUI.ha.lum.setValue( 0.5 ); dlg.lineUI.ha.detail.setValue( 1 );
   dlg.clickPreview( cx, cy );
   T.log( "dialog crop: " + dlg.status.text + " bitmap " + dlg.preview.bitmap.width + "x" + dlg.preview.bitmap.height + " cropMode " + dlg.cropMode );
   dlg.preview.bitmap.save( T.OUT + "/nbadd_dialog_crop.png" );
   dlg.clickPreview( 100, 100 );   // moves the crop (coordinates inside the current crop)
   T.log( "dialog crop moved to " + dlg.d.crop.x0 + "," + dlg.d.crop.y0 );
   dlg.cropCheck.checked = false; dlg.setCropMode( false );
   T.log( "dialog whole preview " + dlg.preview.bitmap.width + "x" + dlg.preview.bitmap.height );
   t0 = Date.now();
   dlg.doRun();
   T.log( "dialog run: " + dlg.status.text + " in " + ( ( Date.now() - t0 ) / 1000 ).toFixed( 1 ) + " s" );
   let outView = View.viewById( "T_noisy_NB" );
   T.log( "history: " + outView.window.keywords.filter( k => k.name == "HISTORY" ).map( k => k.comment ).join( " | " ) );
   dlg.cleanup();
} );
