// Headless test of hole detection/repair on NB_OLD (reference: user-healed NB_ha).
#engine v8
#include "../lib/CTCore.js"
#include "../lib/CTRepair.js"
#include "TestUtil.js"

T.starless = function( srcView, cacheName )
{
   let path = T.OUT + "/" + cacheName + ".xisf";
   if ( File.exists( path ) )
      return T.open( path );
   let r = CT.runStarX( srcView, {} );
   r.window.saveAs( path, false, false, false, false );
   return r.window.mainView;
};

T.run( "repair", function()
{
   let old = T.open( T.DATA + "NB_OLD.tif" ), healed = T.open( T.DATA + "NB_ha.tif" );
   let R = T.open( T.DATA + "Image292_R.tif" ), ha = T.open( T.DATA + "ha.tif" );
   let g = CT.geometry( old ), W = g.W, H = g.H, N = W * H;
   let a = CT.getChannel( old, 0 ), hl = CT.getChannel( healed, 0 ), ref = CT.getChannel( R, 0 );
   let haSL = T.starless( ha, "ha_starless" );
   let guide = CT.getChannel( haSL, 0 );

   let p = CTRepair.defaults();
   p.debug = true;
   let t0 = Date.now();
   let det = CTRepair.detect( a, W, H, ref, p );
   T.log( "detect s " + ( ( Date.now() - t0 ) / 1000 ) + " blobs " + det.blobs.length + " accepted " + det.blobs.filter( b => b.accepted ).length );
   for ( let pt of [ [ 2733, 990 ], [ 3438, 3004 ], [ 5673, 1163 ], [ 470, 2017 ], [ 241, 2621 ], [ 1200, 1268 ] ] )
   {
      let near = det.all.filter( b => pt[0] >= b.x0 - 3 && pt[0] <= b.x1 + 3 && pt[1] >= b.y0 - 3 && pt[1] <= b.y1 + 3 );
      T.log( "  at " + pt + ": " + JSON.stringify( near.map( b => ( { area: b.area, bw: b.x1 - b.x0 + 1, bh: b.y1 - b.y0 + 1,
         aspect: +( b.aspect || 0 ).toFixed( 2 ), fill: +( b.fill || 0 ).toFixed( 2 ), reason: b.reason, hasStar: b.hasStar, accepted: b.accepted } ) ) ) );
   }

   File.writeTextFile( T.OUT + "/repair_blobs.json", JSON.stringify( det.blobs.map( b => ( {
      x: +b.cx.toFixed( 1 ), y: +b.cy.toFixed( 1 ), r: +CTRepair.repairRadius( b, p ).toFixed( 1 ), rb: b.r, acc: b.accepted ? 1 : 0,
      core: +b.coreFrac.toFixed( 3 ), minRel: +b.minRel.toFixed( 3 ), star: +( b.starPeak || 0 ).toFixed( 1 ), fill: +b.fill.toFixed( 2 ),
      depth: +b.depth.toFixed( 4 ), minv: +b.minv.toFixed( 4 ) } ) ) ) );

   // user heal mask and the black cores inside it
   let heal = new Uint8Array( N ), cores = 0;
   for ( let i = 0; i < N; ++i ) if ( Math.abs( a[i] - hl[i] ) > 0.002 ) { heal[i] = 1; if ( a[i] <= 0 ) ++cores; }

   for ( let mode of [ "guided", "smooth" ] )
   {
      t0 = Date.now();
      let res = CTRepair.repair( [ a ], det, mode == "guided" ? [ guide ] : null, p );
      let o = res.channels[0];
      let covered = 0, zerosLeftInHeal = 0, zerosAll = 0, zerosBefore = 0, dsum = 0, dn = 0, dsum0 = 0;
      for ( let i = 0; i < N; ++i )
      {
         if ( a[i] <= 0 ) ++zerosBefore;
         if ( o[i] <= 0 ) ++zerosAll;
         if ( heal[i] )
         {
            if ( a[i] <= 0 && res.mask[i] > 0.5 ) ++covered;
            if ( o[i] <= 0 ) ++zerosLeftInHeal;
            dsum += Math.abs( o[i] - hl[i] ); dsum0 += Math.abs( a[i] - hl[i] ); ++dn;
         }
      }
      T.log( mode + ": s " + ( ( Date.now() - t0 ) / 1000 ) + " repaired " + res.repaired +
             " | black cores in user heal areas covered " + covered + "/" + cores +
             " | zeros left in heal areas " + zerosLeftInHeal +
             " | zeros image before/after " + zerosBefore + "/" + zerosAll +
             " | mean |out-userHeal| in heal areas " + ( dsum / dn ).toFixed( 5 ) + " (original " + ( dsum0 / dn ).toFixed( 5 ) + ")" );
      T.dump( "repair_" + mode, o );
      if ( mode == "guided" ) T.dump( "repair_mask", res.mask );
   }
} );
