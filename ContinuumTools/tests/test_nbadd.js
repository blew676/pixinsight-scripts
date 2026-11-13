// Headless test of Add Narrowband to RGB: the engine must equal the original
// PixelMath recipes (H-alpha then OIII), honor masks, and the dialog must run.
#engine v8
#include "../lib/CTCore.js"
#include "../lib/NBAddEngine.js"
#include "../lib/NBAddDialog.js"
#include "TestUtil.js"

T.pixelMath = function( view, nbId, w, m )
{
   let e = function( W ) { return "$T * ~" + W + " + " + W + " * mtf(~m, (mtf(m, $T) + mtf(m, " + nbId + ")))"; };
   let P = new PixelMath;
   P.expression = e( "R" ); P.expression1 = e( "G" ); P.expression2 = e( "B" ); P.expression3 = "";
   P.useSingleExpression = false;
   P.symbols = "R = " + w[0] + ", G = " + w[1] + ", B = " + w[2] + ", m = " + m;
   P.generateOutput = true; P.singleThreaded = false; P.optimization = true;
   P.use64BitWorkingImage = false; P.rescale = false;
   P.truncate = true; P.truncateLower = 0; P.truncateUpper = 1;
   P.createNewImage = false;
   if ( !P.executeOn( view ) )
      throw new Error( "PixelMath failed" );
};

T.compare = function( name, a, b )
{
   let mx = 0, n = 0;
   for ( let c = 0; c < 3; ++c )
      for ( let i = 0; i < a[c].length; ++i )
      {
         let d = Math.abs( a[c][i] - b[c][i] );
         if ( d > mx ) mx = d;
         if ( d > 1e-5 ) ++n;
      }
   T.log( name + ": max |diff| " + mx.toExponential( 2 ) + ", samples off by more than 1e-5: " + n );
   return mx;
};

T.run( "nbadd", function()
{
   CT.errorBox = function( m ) { T.log( "ERRORBOX: " + m ); };
   let R = T.open( T.DATA + "Image292_R.tif" ), ha = T.open( T.DATA + "ha.tif" );
   let nbHa = T.open( T.DATA + "NB_ha.tif" ), nbO3 = T.open( T.DATA + "NB_OLD.tif" );
   nbHa.id = "NBha"; nbO3.id = "NBo3";
   let g = CT.geometry( R ), W = g.W, H = g.H;
   // a stretched stand-in RGB image: R = stretched R, G = stretched H-alpha, B = NB_OLD
   let st = function( a ) { let s = CT.autoStretch( a ); for ( let i = 0; i < a.length; ++i ) a[i] = CT.applyStretch( a[i], s ); return a; };
   let rgb = [ st( CT.getChannel( R, 0 ) ), st( CT.getChannel( ha, 0 ) ), CT.getChannel( nbO3, 0 ) ];
   let mk = function( id ) { return CT.createWindow( id, W, H, rgb.map( a => Float32Array.from( a ) ), { show: false } ).mainView; };
   let tgt = mk( "T_rgb" ), ref = mk( "T_pm" );

   // 1. default settings vs the two PixelMath instances (H-alpha, then OIII)
   T.pixelMath( ref, "NBha", [ 1.0, 0.0, 0.05 ], 0.999 );
   T.pixelMath( ref, "NBo3", [ 0.0, 1.0, 1.5 ], 0.999 );
   let d = NBADD.load( tgt, { ha: nbHa, o3: nbO3, s2: null } );
   let p = NBADD.defaults();
   let out = NBADD.apply( d.target, d.lines, p );
   let mx1 = T.compare( "defaults vs PixelMath Ha+OIII", out, CT.getChannels( ref ) );

   // 2. another m and weights, H-alpha only
   let ref2 = mk( "T_pm2" );
   T.pixelMath( ref2, "NBha", [ 0.7, 0.3, -0.2 ], 0.95 );
   let p2 = NBADD.defaults();
   p2.m = 0.95; p2.ha_r = 0.7; p2.ha_g = 0.3; p2.ha_b = -0.2;
   let d2 = NBADD.load( tgt, { ha: nbHa, o3: null, s2: null } );
   let mx2 = T.compare( "m=0.95, weights 0.7/0.3/-0.2 vs PixelMath", NBADD.apply( d2.target, d2.lines, p2 ), CT.getChannels( ref2 ) );

   // 3. masks: in place (PixInsight applies the mask) and new image (applied by the engine)
   let mask = new Float32Array( W * H );
   for ( let y = 0; y < H; ++y ) for ( let x = 0; x < W; ++x ) mask[y * W + x] = x / ( W - 1 );
   let maskWin = CT.createWindow( "M_grad", W, H, [ mask ], { show: false } );
   let expect = [ 0, 1, 2 ].map( c => { let o = new Float32Array( W * H ); for ( let i = 0; i < o.length; ++i ) o[i] = rgb[c][i] + mask[i] * ( out[c][i] - rgb[c][i] ); return o; } );
   let inPlace = mk( "T_mask_inplace" );
   inPlace.window.setMask( maskWin, false ); inPlace.window.maskEnabled = true;
   let pi = NBADD.defaults(); pi.newImage = false;
   NBADD.execute( NBADD.load( inPlace, { ha: nbHa, o3: nbO3 } ), inPlace, pi );
   let mx3 = T.compare( "in place with gradient mask", CT.getChannels( inPlace ), expect );
   T.compare( "  (in place vs unmasked result)", CT.getChannels( inPlace ), out );
   let newImg = mk( "T_mask_new" );
   newImg.window.setMask( maskWin, false ); newImg.window.maskEnabled = true;
   let wNew = NBADD.execute( NBADD.load( newImg, { ha: nbHa, o3: nbO3 } ), newImg, NBADD.defaults() );
   let mx4 = T.compare( "new image with gradient mask", CT.getChannels( wNew.mainView ), expect );
   T.log( "keywords: " + wNew.keywords.filter( k => k.name == "HISTORY" ).map( k => k.comment ).join( " | " ) );

   // 4. black point and strength move things the expected way
   let p5 = NBADD.defaults(); p5.ha_black = NBADD.autoBlack( d.lines[0].data, W, H );
   let o5 = NBADD.apply( d.target, d.lines, p5 );
   let mean = a => { let s = 0; for ( let i = 0; i < a.length; i += 7 ) s += a[i]; return s / Math.ceil( a.length / 7 ); };
   T.log( "auto black (NB_ha) " + p5.ha_black.toFixed( 4 ) + "; mean R: original " + mean( rgb[0] ).toFixed( 4 ) +
          ", defaults " + mean( out[0] ).toFixed( 4 ) + ", with black point " + mean( o5[0] ).toFixed( 4 ) );

   // 5. dialog, driven like a user
   let dlg = new NBAddDialog();
   dlg.targetList.currentView = tgt;
   dlg.lineUI.ha.list.currentView = nbHa;
   dlg.lineUI.o3.list.currentView = nbO3;
   dlg.inputsChanged();
   dlg.doPreview();
   T.log( "dialog preview: " + dlg.status.text + " bitmap " + ( dlg.preview.bitmap ? dlg.preview.bitmap.width + "x" + dlg.preview.bitmap.height : "none" ) );
   dlg.preview.bitmap.save( T.OUT + "/nbadd_preview.png" );
   dlg.showOriginal = true; dlg.renderPreview(); dlg.preview.bitmap.save( T.OUT + "/nbadd_preview_original.png" );
   dlg.showOriginal = false;
   dlg.doAutoBlack( "ha" );
   T.log( "dialog auto black: " + dlg.status.text );
   dlg.resetLine( "ha" );
   T.log( "after reset ha_black " + dlg.p.ha_black );
   dlg.doRun();
   T.log( "dialog run: " + dlg.status.text );
   dlg.cleanup();

   if ( mx1 > 1e-5 || mx2 > 1e-5 || mx3 > 1e-4 || mx4 > 1e-4 )
      throw new Error( "results differ from the expected values" );
} );
