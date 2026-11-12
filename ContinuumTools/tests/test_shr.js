// Headless test of the Star Hole Repair dialog on NB_OLD (ref R, guide H-alpha starless).
#engine v8
#include "../lib/CTCore.js"
#include "../lib/CTRepair.js"
#include "../lib/SHREngine.js"
#include "../lib/SHRDialog.js"
#include "TestUtil.js"

T.run( "shr", function()
{
   CT.errorBox = function( m ) { T.log( "ERRORBOX: " + m ); };
   let old = T.open( T.DATA + "NB_OLD.tif" ), R = T.open( T.DATA + "Image292_R.tif" );
   let guide = T.open( T.OUT + "/ha_starless.xisf" );
   old.id = "NB_OLD"; R.id = "R"; guide.id = "ha_starless";

   let d = new SHRDialog();
   T.log( "dialog constructed; defaults " + JSON.stringify( d.p ) );
   d.targetList.currentView = old; d.refList.currentView = R; d.guideList.currentView = guide;
   d.inputsChanged();
   d.doDetect();
   T.log( "detect: " + d.countInfo.text );
   // draw the overlay into a copy of the preview bitmap
   let bmp = new Bitmap( d.preview.bitmap );
   let g = new Graphics( bmp );
   d.drawOverlay( g, { zoom: 1 } );
   g.end();
   bmp.save( T.OUT + "/shr_overlay.png" );
   T.log( "overlay bitmap " + bmp.width + "x" + bmp.height + " f=" + d.s.preview.f );

   // toggle the blob nearest to a known rejected real hole (470,2017) and an accepted one
   let before = SHR.counts( d.s );
   d.toggleAt( 470, 2017 );
   let after = SHR.counts( d.s );
   T.log( "toggle: before " + JSON.stringify( before ) + " after " + JSON.stringify( after ) );

   d.doRepairPreview();
   T.log( "repair preview: " + d.status.text );
   d.preview.bitmap.save( T.OUT + "/shr_repaired_preview.png" );
   d.p.makeMask = true;
   d.doRun();
   T.log( "run: " + d.status.text );
   let out = View.viewById( "NB_OLD_repaired" );
   T.log( "output exists " + CT.isView( out ) + " mask exists " + CT.isView( View.viewById( "NB_OLD_holemask" ) ) );
   if ( CT.isView( out ) ) T.dump( "shr_out", CT.getChannel( out, 0 ) );

   // no-reference, no-guide path
   let d2 = new SHRDialog();
   d2.targetList.currentView = old; d2.inputsChanged();
   d2.doDetect();
   T.log( "no-reference detect: " + d2.countInfo.text );
   let bmp2 = new Bitmap( d2.preview.bitmap );
   let g2 = new Graphics( bmp2 );
   d2.drawOverlay( g2, { zoom: 1 } );
   g2.end();
   bmp2.save( T.OUT + "/shr_overlay_noref.png" );
   d2.doRepairPreview();
   T.log( "no-reference repair: " + d2.status.text );
   d.cleanup(); d2.cleanup();
} );
