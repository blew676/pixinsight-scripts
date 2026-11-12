// ----------------------------------------------------------------------------
// ContinuumTools - Star Hole Repair engine (wraps CTRepair for the dialog)
// ----------------------------------------------------------------------------

var SHR = {};

SHR.TOOL = "SHR";

SHR.defaults = function()
{
   let p = CTRepair.defaults();
   p.newImage = true;      // create a new image (false: modify the target, undoable)
   p.makeMask = false;     // also output the repair mask
   p.showRejected = true;  // draw rejected candidates in the preview
   p.suffix = "_repaired";
   return p;
};

SHR.validate = function( target, ref, guide )
{
   if ( !CT.isView( target ) )
      throw new Error( "Select the image to repair." );
   if ( CT.isView( ref ) )
      CT.requireSameGeometry( target, ref, "Target / star reference" );
   if ( CT.isView( guide ) )
      CT.requireSameGeometry( target, guide, "Target / guide" );
};

// Loads everything needed. Returns a session object.
SHR.load = function( target, ref, guide )
{
   SHR.validate( target, ref, guide );
   let g = CT.geometry( target );
   let s = { W: g.W, H: g.H, color: g.C >= 3,
             ids: [ target.id, CT.isView( ref ) ? ref.id : "", CT.isView( guide ) ? guide.id : "" ].join( "|" ) };
   s.channels = [];
   for ( let c = 0; c < ( s.color ? 3 : 1 ); ++c )
      s.channels.push( CT.getChannel( target, c ) );
   if ( s.color )
   {
      s.lum = new Float32Array( g.W * g.H );
      for ( let c = 0; c < 3; ++c )
         for ( let i = 0; i < s.lum.length; ++i )
            s.lum[i] += s.channels[c][i] / 3;
   }
   else
      s.lum = s.channels[0];
   s.ref = CT.isView( ref ) ? CT.getLuminance( ref ) : null;
   s.guide = null;
   if ( CT.isView( guide ) )
   {
      s.guide = [];
      let gc = guide.image.numberOfChannels >= 3 && s.color ? 3 : 1;
      for ( let c = 0; c < gc; ++c )
         s.guide.push( CT.getChannel( guide, c ) );
   }
   s.det = null;
   s.result = null;
   return s;
};

SHR.detect = function( s, p )
{
   s.det = CTRepair.detect( s.lum, s.W, s.H, s.ref, p );
   s.result = null;
   return s.det;
};

SHR.counts = function( s )
{
   let acc = 0, rej = 0;
   if ( s.det )
      for ( let b of s.det.blobs )
         if ( b.accepted ) ++acc; else ++rej;
   return { accepted: acc, rejected: rej };
};

SHR.repair = function( s, p )
{
   if ( !s.det )
      SHR.detect( s, p );
   s.result = CTRepair.repair( s.channels, s.det, s.guide, p );
   return s.result;
};

// Nearest candidate to an image position (within its radius, or a minimum
// pick distance), or null.
SHR.pick = function( s, p, x, y, minDist )
{
   if ( !s.det )
      return null;
   let best = null, bd = Infinity;
   for ( let b of s.det.blobs )
   {
      let d = Math.sqrt( ( b.cx - x ) * ( b.cx - x ) + ( b.cy - y ) * ( b.cy - y ) );
      let lim = Math.max( CTRepair.repairRadius( b, p ), minDist || 0 );
      if ( d <= lim && d < bd ) { bd = d; best = b; }
   }
   return best;
};

SHR.output = function( s, target, p )
{
   if ( !s.result )
      SHR.repair( s, p );
   let hist = [ "ContinuumTools StarHoleRepair " + CT.VERSION + ": " + s.result.repaired + " holes repaired" +
                ( s.guide ? " (guided)" : "" ) ];
   let win = null;
   let out = s.result.channels.map( function( a ) { return Float32Array.from( a ); } );
   if ( p.newImage )
      win = CT.createWindow( target.id + p.suffix, s.W, s.H, out, { keywordsFrom: target, history: hist } );
   else
   {
      CT.writeToView( target, out );
      win = target.window;
   }
   if ( p.makeMask )
      CT.createWindow( target.id + "_holemask", s.W, s.H, [ Float32Array.from( s.result.mask ) ], {} );
   return win;
};

// Preview -------------------------------------------------------------------

SHR.previewSetup = function( s, maxW, maxH )
{
   let f = CT.previewFactor( s.W, s.H, maxW, maxH );
   let pv = { f: f };
   pv.orig = s.channels.map( function( a ) { return CT.downsample( a, s.W, s.H, f ).a; } );
   let d0 = CT.downsample( s.channels[0], s.W, s.H, f );
   pv.W = d0.W; pv.H = d0.H;
   // display only: an AutoSTF makes holes easy to see on linear and stretched data
   pv.stretch = pv.orig.map( function( a ) { return CT.autoStretch( a ); } );
   pv.repaired = null;
   s.preview = pv;
   return pv;
};

SHR.previewRepaired = function( s )
{
   let pv = s.preview;
   pv.repaired = s.result ? s.result.channels.map( function( a ) { return CT.downsample( a, s.W, s.H, pv.f ).a; } ) : null;
};

SHR.previewBitmap = function( s, showRepaired )
{
   let pv = s.preview;
   let ch = ( showRepaired && pv.repaired ) ? pv.repaired : pv.orig;
   return CT.renderBitmap( ch, pv.W, pv.H, pv.stretch );
};
