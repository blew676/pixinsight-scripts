// Headless test of the shared core. Run with tests/run_test.ps1 test_core.js <outdir>
#engine v8
#include "../lib/CTCore.js"
#include "TestUtil.js"

T.run( "core", function()
{
   let ha = T.open( T.DATA + "ha.tif" ), R = T.open( T.DATA + "Image292_R.tif" );
   let g = CT.geometry( ha );
   T.log( "geometry " + JSON.stringify( g ) );
   let a = CT.getChannel( ha, 0 ), b = CT.getChannel( R, 0 );
   let t0 = Date.now();
   let st = CT.robustStats( a );
   T.log( "robustStats ha " + JSON.stringify( st ) + " ms " + ( Date.now() - t0 ) );
   t0 = Date.now();
   T.log( "noise ha " + CT.noiseSigma( a, g.W, g.H ) + " R " + CT.noiseSigma( b, g.W, g.H ) + " ms " + ( Date.now() - t0 ) );
   t0 = Date.now();
   let res = CT.measureContinuumRatio( a, b, g.W, g.H, {} );
   T.log( "measureContinuumRatio " + JSON.stringify( res ) + " ms " + ( Date.now() - t0 ) );
   t0 = Date.now();
   let c = CT.closing( a, g.W, g.H, 20 );
   T.log( "closing r=20 ms " + ( Date.now() - t0 ) + " c[5000000]=" + c[5000000] );
   t0 = Date.now();
   let d = CT.downsample( a, g.W, g.H, 4 );
   let s = CT.autoStretch( d.a );
   let bmp = CT.renderBitmap( [ d.a ], d.W, d.H, [ s ] );
   T.log( "render " + bmp.width + "x" + bmp.height + " stretch " + JSON.stringify( s ) + " ms " + ( Date.now() - t0 ) );
   bmp.save( T.OUT + "/core_preview.png" );
   // push-pull sanity: fill a hole in a ramp
   let w = 40, h = 30, v = new Float32Array( w * h ), k = new Float32Array( w * h );
   for ( let y = 0; y < h; ++y ) for ( let x = 0; x < w; ++x ) { v[y * w + x] = x / w; k[y * w + x] = ( ( x - 20 ) * ( x - 20 ) + ( y - 15 ) * ( y - 15 ) < 64 ) ? 0 : 1; }
   let f = CT.pushPull( v, k, w, h );
   T.log( "pushPull center " + f[15 * w + 20] + " (expect ~0.5)" );
   CT.relaxLaplace( f, k, w, h, 80 );
   T.log( "relaxed center " + f[15 * w + 20] + " (expect ~0.5)" );
   let ctl = new CT.PreviewControl( null );
   T.log( "PreviewControl constructed " + ( typeof ctl.setBitmap ) );
} );
