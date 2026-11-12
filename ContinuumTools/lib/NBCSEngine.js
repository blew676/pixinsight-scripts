// ----------------------------------------------------------------------------
// ContinuumTools - Narrowband Continuum Subtraction engine
// ----------------------------------------------------------------------------
//
// Model (all images linear, registered, background-referenced):
//    NB = Line + k * Continuum          (narrowband filter: line + a little continuum)
//    BB = Continuum + c * Line          (broadband filter: continuum + some line light)
// =>  Line = ( NB - k * BB ) / ( 1 - k*c )
//
// k is measured from stars, which are pure continuum: k = flux(NB) / flux(BB)
// for isolated, unsaturated stars (median over many stars). This must be done
// on images WITH stars. The subtraction itself is then applied to STARLESS
// versions of both images, so no star residuals (bright or dark) are created.
//
// Why not measure k on the starless images? Without stars the only common
// structure left is the nebula itself, and because the broadband filter also
// passes the emission line, matching the two images there scales the
// continuum up until it cancels the nebula: a flat, featureless result.
//
// Optional "add narrowband stars": the starless continuum is subtracted from
// the STARRED narrowband image instead, which leaves the narrowband's own
// stars intact (natural star profiles, no rings or holes).
// ----------------------------------------------------------------------------

var NBCS = {};

NBCS.TOOL = "NBCS";

NBCS.defaults = function()
{
   return {
      bbChannel: 0,         // channel of a color continuum image (0=R, 1=G, 2=B)
      k: 0,                 // continuum scale factor (0 = not measured)
      c: 0,                 // line light in the continuum filter (flux correction; 0 = off)
      starless: true,       // subtract starless versions (recommended)
      addStars: false,      // starless mode: keep the narrowband's own stars
      keepStarless: true,   // leave StarXTerminator-generated starless images open
      suffix: "_CS"
   };
};

NBCS.channelOf = function( view, p )
{
   let n = view.image.numberOfChannels;
   return n > 1 ? Math.max( 0, Math.min( n - 1, Math.round( p.bbChannel ) ) ) : 0;
};

NBCS.validateInputs = function( nbView, bbView )
{
   if ( !CT.isView( nbView ) )
      throw new Error( "Select the narrowband image." );
   if ( !CT.isView( bbView ) )
      throw new Error( "Select the continuum (broadband) image." );
   if ( nbView.id == bbView.id )
      throw new Error( "The narrowband and continuum images must be different images." );
   CT.requireSameGeometry( nbView, bbView, "Narrowband / continuum" );
};

// Measures k on the starred images.
NBCS.measure = function( nbView, bbView, p )
{
   NBCS.validateInputs( nbView, bbView );
   let g = CT.geometry( nbView );
   CT.note( "Measuring the continuum scale factor from stars: " + nbView.id + " / " + bbView.id );
   let nb = CT.getChannel( nbView, 0 );
   let bb = CT.getChannel( bbView, NBCS.channelOf( bbView, p ) );
   return CT.measureContinuumRatio( nb, bb, g.W, g.H, {} );
};

// Session cache of pixel data, so previews and repeated runs do not reload
// images or re-run StarXTerminator.
NBCS.Cache = function()
{
   this.key = "";
   this.nb = null; this.bb = null;
   this.generated = [];   // { src: source view id, win: StarXTerminator output window }
   this.stats = null;
   this.preview = null;
};

NBCS.Cache.prototype.release = function( keepWindows )
{
   for ( let i = 0; i < this.generated.length; ++i )
   {
      let w = this.generated[i].win;
      try
      {
         if ( w && !w.isNull )
         {
            if ( keepWindows ) { w.show(); w.zoomToFit(); }
            else w.forceClose();
         }
      }
      catch ( e ) {}
   }
   this.generated = [];
   this.key = "";
   this.nb = this.bb = null;
   this.stats = null;
   this.preview = null;
};

// Loads the pixel data used for the subtraction (starless or starred) into
// the cache. nbSL / bbSL are optional user-supplied starless views; missing
// ones are generated with StarXTerminator (once per session).
NBCS.prepare = function( cache, nbView, bbView, nbSL, bbSL, p )
{
   NBCS.validateInputs( nbView, bbView );
   let ch = NBCS.channelOf( bbView, p );
   let key = [ nbView.id, bbView.id, ch, p.starless ? 1 : 0,
               p.starless && CT.isView( nbSL ) ? nbSL.id : "-",
               p.starless && CT.isView( bbSL ) ? bbSL.id : "-" ].join( "|" );
   if ( cache.key == key && cache.nb && cache.bb )
   {
      if ( p.starless && p.addStars && !cache.nbStarred )
         cache.nbStarred = CT.getChannel( nbView, 0 );
      return cache;
   }
   cache.nbStarred = null;

   // Generated windows from a previous configuration are kept only if they are
   // still the right ones; otherwise discarded.
   let reuse = {};
   for ( let i = 0; i < cache.generated.length; ++i )
   {
      let gw = cache.generated[i];
      if ( gw.win && !gw.win.isNull )
         reuse[ gw.src ] = gw.win;
   }

   cache.nb = cache.bb = null; cache.stats = null; cache.preview = null;
   let keepGenerated = [];
   let g = CT.geometry( nbView );

   if ( !p.starless )
   {
      cache.nb = CT.getChannel( nbView, 0 );
      cache.bb = CT.getChannel( bbView, ch );
   }
   else
   {
      let get = function( src, user, chan )
      {
         if ( CT.isView( user ) )
         {
            CT.requireSameGeometry( src, user, "Starless image" );
            return CT.getChannel( user, user.image.numberOfChannels > 1 ? chan : 0 );
         }
         let w = reuse[ src.id ];
         if ( !w )
            w = CT.runStarX( src, {} ).window;
         keepGenerated.push( { src: src.id, win: w } );
         return CT.getChannel( w.mainView, w.mainView.image.numberOfChannels > 1 ? chan : 0 );
      };
      cache.nb = get( nbView, nbSL, 0 );
      cache.bb = get( bbView, bbSL, ch );
      if ( p.addStars )
         cache.nbStarred = CT.getChannel( nbView, 0 );
   }
   // close generated windows that are no longer used
   for ( let id in reuse )
   {
      let used = false;
      for ( let i = 0; i < keepGenerated.length; ++i )
         if ( keepGenerated[i].win === reuse[id] ) used = true;
      if ( !used )
         try { reuse[id].forceClose(); } catch ( e ) {}
   }
   cache.generated = keepGenerated;

   let sNB = CT.robustStats( cache.nb ), sBB = CT.robustStats( cache.bb );
   cache.stats = { W: g.W, H: g.H, pivot: sNB.median, bgBB: sBB.median };
   cache.key = key;
   return cache;
};

// Core arithmetic, works on any pair of equally sized buffers.
NBCS.subtract = function( nb, bb, k, c, stats, out )
{
   let gain = 1 / Math.max( 0.05, 1 - k * c );
   let piv = stats.pivot, bg = stats.bgBB;
   out = out || new Float32Array( nb.length );
   for ( let i = 0, n = nb.length; i < n; ++i )
      out[i] = piv + gain * ( nb[i] - piv - k * ( bb[i] - bg ) );
   return out;
};

// The narrowband buffer used in the subtraction for the current options.
NBCS.nbSource = function( cache, p )
{
   return ( p.starless && p.addStars && cache.nbStarred ) ? cache.nbStarred : cache.nb;
};

// Full-resolution result. Returns { channels, clippedLow }.
NBCS.compute = function( cache, p )
{
   let out = NBCS.subtract( NBCS.nbSource( cache, p ), cache.bb, p.k, p.c, cache.stats );
   let low = 0;
   for ( let i = 0, n = out.length; i < n; ++i )
      if ( out[i] < 0 ) ++low;
   return { channels: [ out ], clippedLow: low };
};

NBCS.history = function( p, nbView, bbView )
{
   return [
      "ContinuumTools NBCS " + CT.VERSION + ": " + nbView.id + " - k*" + bbView.id,
      "k=" + CT.fmt( p.k, 5 ) + " c=" + CT.fmt( p.c, 3 ) + " mode=" +
      ( p.starless ? ( p.addStars ? "starless continuum, narrowband stars kept" : "starless" ) : "starred" )
   ];
};

// Runs everything and creates the output window. Returns the window.
NBCS.execute = function( cache, nbView, bbView, nbSL, bbSL, p )
{
   if ( !( p.k > 0 ) )
   {
      let m = NBCS.measure( nbView, bbView, p );
      p.k = m.k;
   }
   NBCS.prepare( cache, nbView, bbView, nbSL, bbSL, p );
   let t0 = Date.now();
   let r = NBCS.compute( cache, p );
   let st = cache.stats;
   if ( r.clippedLow > 0 )
      CT.log( r.clippedLow + " pixels (" + CT.fmt( 100 * r.clippedLow / ( st.W * st.H ), 3 ) +
              " percent) were below zero and clipped" );
   if ( !p.starless )
      CT.warn( "Starred mode: star residuals (rings / dark holes) remain. Starless mode avoids them." );
   let win = CT.createWindow( nbView.id + p.suffix, st.W, st.H, r.channels,
                              { keywordsFrom: nbView, history: NBCS.history( p, nbView, bbView ) } );
   CT.note( format( "Created %s  (k = %.4f%s, %.1f s)", win.mainView.id, p.k,
                    p.c > 0 ? ", c = " + CT.fmt( p.c, 3 ) : "", ( Date.now() - t0 ) / 1000 ) );
   return win;
};

// Preview data: downsampled buffers for interactive k adjustment.
NBCS.previewSetup = function( cache, maxW, maxH )
{
   let st = cache.stats;
   let f = CT.previewFactor( st.W, st.H, maxW, maxH );
   let a = CT.downsample( cache.nb, st.W, st.H, f );
   let b = CT.downsample( cache.bb, st.W, st.H, f );
   let s = cache.nbStarred ? CT.downsample( cache.nbStarred, st.W, st.H, f ).a : null;
   cache.preview = { f: f, W: a.W, H: a.H, nb: a.a, nbStarred: s, bb: b.a,
                     out: new Float32Array( a.a.length ), stretch: null };
   return cache.preview;
};

NBCS.previewBitmap = function( cache, p, restretch )
{
   let pv = cache.preview;
   let nb = ( p.starless && p.addStars && pv.nbStarred ) ? pv.nbStarred : pv.nb;
   NBCS.subtract( nb, pv.bb, p.k, p.c, cache.stats, pv.out );
   if ( restretch || !pv.stretch )
      pv.stretch = CT.autoStretch( pv.out );
   return CT.renderBitmap( [ pv.out ], pv.W, pv.H, [ pv.stretch ] );
};
