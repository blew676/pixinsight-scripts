// Headless test of broadband line removal: R minus H-alpha line (from NBCS).
#engine v8
#include "../lib/CTCore.js"
#include "../lib/NBCSEngine.js"
#include "../lib/BBLREngine.js"
#include "../lib/BBLRDialog.js"
#include "TestUtil.js"

T.run( "bblr", function()
{
   CT.errorBox = function( m ) { T.log( "ERRORBOX: " + m ); };
   let ha = T.open( T.DATA + "ha.tif" ), R = T.open( T.DATA + "Image292_R.tif" );
   ha.id = "ha"; R.id = "R";
   let haSL = T.open( T.OUT + "/ha_starless.xisf" ), rSL = T.open( T.OUT + "/R_starless.xisf" );
   let p1 = NBCS.defaults();
   let line = NBCS.execute( new NBCS.Cache(), ha, R, haSL, rSL, p1 ).mainView;
   T.log( "line image " + line.id + " k=" + p1.k + " lineK(history)=" + BBLR.lineK( line ) );

   let d = BBLR.load( R, line, null );
   let p = BBLR.defaults();
   p.tBB = 180; p.tHa = 600; p.monoFilter = 0;
   let rows = BBLR.activeRows( false, p, true, false );
   T.log( "rows " + rows.map( r => r.key ).join( "," ) );
   let phys = BBLR.physicsEstimate( p, rows, d.kHa, d.kO3 );
   T.log( "physics estimate " + JSON.stringify( phys ) );
   let img = BBLR.imageEstimate( d.bb[0], d.lines[0], d.W, d.H, d.L0[0] );
   T.log( "image estimate " + img + " L0 " + d.L0[0] );
   p.aR_Ha = phys.aR_Ha;
   let w = BBLR.execute( d, R, p );
   T.dump( "bblr_R_phys", CT.getChannel( w.mainView, 0 ) );
   p.aR_Ha = img;
   let w2 = BBLR.execute( d, R, p );
   T.dump( "bblr_R_img", CT.getChannel( w2.mainView, 0 ) );

   // dialog smoke test
   let dlg = new BBLRDialog();
   dlg.targetList.currentView = R; dlg.haList.currentView = line; dlg.inputsChanged();
   dlg.p.tBB = 180; dlg.p.tHa = 600;
   dlg.doPhysics();
   T.log( "dialog physics: " + dlg.status.text + " aR_Ha=" + dlg.p.aR_Ha + " visible R row " + dlg.amountControls.aR_Ha.visible + " G row " + dlg.amountControls.aG_O3.visible );
   dlg.doPreview();
   T.log( "dialog preview: " + dlg.status.text );
   dlg.preview.bitmap.save( T.OUT + "/bblr_dialog_preview.png" );
   dlg.doImageEstimate();
   T.log( "dialog image estimate: " + dlg.status.text );
   dlg.doRun();
   T.log( "dialog run: " + dlg.status.text );
   dlg.cleanup();
} );
