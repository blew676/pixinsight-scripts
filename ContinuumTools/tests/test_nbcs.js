// Headless test of the narrowband continuum subtraction engine and dialog on ha + R.
#engine v8
#include "../lib/CTCore.js"
#include "../lib/NBCSEngine.js"
#include "../lib/NBCSDialog.js"
#include "TestUtil.js"

T.run( "nbcs", function()
{
   CT.errorBox = function( m ) { T.log( "ERRORBOX: " + m ); };
   let ha = T.open( T.DATA + "ha.tif" ), R = T.open( T.DATA + "Image292_R.tif" );
   ha.id = "ha"; R.id = "R";
   let haSL = File.exists( T.OUT + "/ha_starless.xisf" ) ? T.open( T.OUT + "/ha_starless.xisf" ) : null;
   let rSL = File.exists( T.OUT + "/R_starless.xisf" ) ? T.open( T.OUT + "/R_starless.xisf" ) : null;
   if ( haSL ) haSL.id = "ha_SL";
   if ( rSL ) rSL.id = "R_SL";

   // engine: starless + keep narrowband stars
   let p = NBCS.defaults();
   p.addStars = true;
   let cache = new NBCS.Cache();
   let win = NBCS.execute( cache, ha, R, haSL, rSL, p );
   T.log( "addStars output " + win.mainView.id + " k=" + p.k );
   T.dump( "nbcs_addstars", CT.getChannel( win.mainView, 0 ) );

   // dialog driven like a user (no StarX: starless views supplied)
   let d = new NBCSDialog();
   T.log( "dialog constructed" );
   d.nbList.currentView = ha;
   d.bbList.currentView = R;
   d.inputsChanged( true );
   if ( haSL ) d.nbSLList.currentView = haSL;
   if ( rSL ) d.bbSLList.currentView = rSL;
   d.inputsChanged( false );
   T.log( "views: " + JSON.stringify( Object.values( d.views() ).map( v => CT.isView( v ) ? v.id : null ) ) );
   d.doMeasure();
   T.log( "measured: " + d.measureInfo.text + " k=" + d.p.k );
   d.doPreview();
   T.log( "preview status: " + d.status.text + " bitmap " + ( d.preview.bitmap ? d.preview.bitmap.width + "x" + d.preview.bitmap.height : "none" ) );
   d.kControl.setValue( 0.2 ); d.p.k = 0.2; d.renderPreview( false );
   d.preview.bitmap.save( T.OUT + "/nbcs_dialog_preview_k020.png" );
   d.p.k = 0.1433; d.renderPreview( false );
   d.preview.bitmap.save( T.OUT + "/nbcs_dialog_preview_k0143.png" );
   d.doRun();
   T.log( "run status: " + d.status.text );
   d.cleanup();
   T.log( "cleanup ok" );
} );
