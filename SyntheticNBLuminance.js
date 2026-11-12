/*
 * SyntheticNBLuminance.js
 *
 * Builds a single luminance master from two or more registered narrowband
 * masters (Ha / OIII / SII ...) using noise-normalized, signal-adaptive
 * weighting.
 *
 * Method
 * ------
 *  1. For each channel, estimate a robust background location (median) and
 *     noise scale (sigma, from an iteratively k-sigma-clipped MAD).
 *  2. Build a Gaussian-smoothed copy of each channel and measure its noise the
 *     same way. The smoothed copy is used only to decide *where* a channel has
 *     real signal, so the decision is driven by structure rather than by noise.
 *     The smoothing scale can be measured from the data: with autoScale on, the
 *     PSF FWHM of each channel is measured from its own stars and the scale is
 *     set to scaleK times it. Per channel, because two filters can differ in
 *     seeing. The choice of scaleK stays manual -- that is a judgment about
 *     what you are detecting, not something the data can settle.
 *  3. Per pixel, each channel gets a weight from a smoothstep ramp over its
 *     local significance, expressed in units of its own smoothed noise sigma:
 *          below tLow  -> weight = floor   (channel is background here)
 *          above tHigh -> weight = 1       (channel has solid signal here)
 *  4. Optionally the weight map is Gaussian-smoothed before use. Without this,
 *     the weight around a star sweeps from 1.0 down to the floor across a
 *     narrow annulus, at a different radius in each channel, so the mixing
 *     ratio swings and swings back within a few pixels and prints a visible
 *     ring. Smoothing the map spreads that transition out.
 *  5. The output is the weighted mean of the sigma-normalized channels:
 *          L = sum( w_i * (v_i - m_i)/g_i ) / sum( w_i )
 *
 * Consequences of (5):
 *  - Where every channel has signal, the result is a straight mean of equally
 *    detected structures -> full sqrt(N) SNR gain.
 *  - Where only one channel has signal, the others are pushed down to the
 *    floor and contribute almost no noise -> faint Ha is not diluted by empty
 *    OIII, and faint OIII is not buried by bright Ha.
 *  - In pure background, all weights equal the floor, so it reduces to a plain
 *    mean, which is the lowest-noise option there.
 *
 * Run this on LINEAR, registered, identically-cropped masters. Do gradient
 * removal and any denoising per channel BEFORE running this. Do not LinearFit
 * first: the sigma normalization here replaces LinearFit and does a better job
 * for this purpose.
 *
 * Written for PixInsight 1.8.9 / PJSR.
 */

#feature-id    Utilities > SyntheticNBLuminance

#feature-info  Combines two or more registered narrowband masters into a \
               single luminance master using noise-normalized, signal-adaptive \
               per-pixel weighting.

#include <pjsr/Sizer.jsh>
#include <pjsr/FrameStyle.jsh>
#include <pjsr/TextAlign.jsh>
#include <pjsr/StdButton.jsh>
#include <pjsr/StdIcon.jsh>
#include <pjsr/StdCursor.jsh>
#include <pjsr/NumericControl.jsh>
#include <pjsr/UndoFlag.jsh>
#include <pjsr/StarDetector.jsh>

#define TITLE    "Synthetic NB Luminance"
#define VERSION  "1.5"

// ----------------------------------------------------------------------------
// Parameters
// ----------------------------------------------------------------------------

var params = {
   viewIds:           [],      // channel views, in order
   weights:           [],      // per-channel weight multiplier, parallel to viewIds
   tLow:              1.5,     // sigma below which a channel counts as background
   tHigh:             5.0,     // sigma above which a channel counts as full signal
   structScale:       3.0,     // Gaussian sigma (px) of the structure-detection blur
   autoScale:         true,    // measure the PSF and derive structScale from it
   scaleK:            1.0,     // structScale = scaleK * measured FWHM, per channel
   weightFloor:       0.15,    // weight given to a channel with no signal
   weightBlur:        0.0,     // Gaussian sigma smoothing the weight map; 0 = off
   autoBlur:          true,    // derive weightBlur from the structure scale
   blurK:             2.0,     // weightBlur = blurK * mean structure scale
   outputId:          "SynthL",
   rescaleOutput:     true,
   makeWeightMaps:    false,
   keepIntermediates: false
};

// ----------------------------------------------------------------------------
// Utilities
// ----------------------------------------------------------------------------

// PixelMath literals: fixed notation avoids any ambiguity in the expression parser.
function fmt( x )
{
   return format( "%.15f", x );
}

function uniqueId( base )
{
   var id = base;
   for ( var i = 1; !ImageWindow.windowById( id ).isNull; ++i )
      id = base + "_" + i;
   return id;
}

/*
 * Robust background location and noise scale.
 *
 * Starts from the global median/MAD, then iterates a 3-sigma clip using the
 * range-clipping facility of the image, so that nebulosity and stars stop
 * biasing the estimate. Returns { location, scale } in normalized [0,1] units.
 */
function robustNoise( image )
{
   var med = image.median();
   var sigma = image.MAD() * 1.4826;
   if ( sigma <= 0 )
      sigma = image.stdDev();

   var savedEnabled = image.rangeClippingEnabled;
   var savedLow = image.rangeClipLow;
   var savedHigh = image.rangeClipHigh;

   try
   {
      for ( var i = 0; i < 8 && sigma > 0; ++i )
      {
         image.rangeClippingEnabled = true;
         image.rangeClipLow  = med - 3*sigma;
         image.rangeClipHigh = med + 3*sigma;

         var m = image.median();
         var s = image.MAD() * 1.4826;
         if ( s <= 0 )
            break;

         var converged = Math.abs( s - sigma )/sigma < 0.005;
         med = m;
         sigma = s;
         if ( converged )
            break;
      }
   }
   catch ( e )
   {
      // Range clipping unavailable for this image; fall back to the global
      // estimate computed above.
   }
   finally
   {
      image.rangeClippingEnabled = savedEnabled;
      image.rangeClipLow = savedLow;
      image.rangeClipHigh = savedHigh;
   }

   if ( !(sigma > 0) )
      sigma = 1.0e-8;

   return { location: med, scale: sigma };
}

/*
 * Area above half maximum for one star, in pixels.
 *
 * The caller converts to FWHM. Area rather than FWHM is returned because the
 * count is an integer: taking a median of the derived FWHM values quantizes
 * the answer in steps of about 0.1 px, which is enough to make two channels
 * that genuinely differ report an identical figure. Averaging areas first
 * avoids that.
 *
 * Only the core of the star is used, so unlike a second-moment estimator this
 * is not inflated by Moffat wings -- which matters when channels differ in
 * beta, as these do.
 *
 * The peak is estimated by fitting a parabola through raw samples, located
 * using 3x3 means. A 3x3 mean is robust for *finding* the star but badly
 * underestimates its amplitude -- by around 12% at a FWHM of 5-6 px -- and an
 * underestimated peak lowers the half-maximum level and inflates the measured
 * width.
 *
 * Returns -1 to reject the star, -2 if the box is too small to contain the
 * core and the caller should grow it.
 */
function starArea( image, x, y, R )
{
   var W = image.width, H = image.height;
   var cx = Math.round( x ), cy = Math.round( y );
   var x0 = cx - R, x1 = cx + R;
   var y0 = cy - R, y1 = cy + R;
   if ( x0 < 2 || y0 < 2 || x1 >= W-2 || y1 >= H-2 )
      return -1;

   // Local sky from the box border, which tracks a nebular pedestal.
   var border = [];
   for ( var xx = x0; xx <= x1; ++xx )
   {
      border.push( image.sample( xx, y0 ) );
      border.push( image.sample( xx, y1 ) );
   }
   for ( var yy = y0+1; yy < y1; ++yy )
   {
      border.push( image.sample( x0, yy ) );
      border.push( image.sample( x1, yy ) );
   }
   border.sort( function( a, b ) { return a - b; } );
   var bkg = border[ border.length >> 1 ];

   // Locate the core with 3x3 means, which a single hot pixel cannot hijack.
   var best = -1, px = cx, py = cy;
   for ( var yy = cy-3; yy <= cy+3; ++yy )
      for ( var xx = cx-3; xx <= cx+3; ++xx )
      {
         var s = 0;
         for ( var j = -1; j <= 1; ++j )
            for ( var k = -1; k <= 1; ++k )
               s += image.sample( xx+k, yy+j );
         if ( s > best )
         {
            best = s;
            px = xx;
            py = yy;
         }
      }

   // Amplitude from parabolic interpolation on raw samples, one axis at a time.
   // For samples a, b, c the vertex value is b - (a-c)^2/(8*(a-2b+c)).
   var b0 = image.sample( px, py );
   var peak = b0;
   var axes = [ [ image.sample( px-1, py ), image.sample( px+1, py ) ],
                [ image.sample( px, py-1 ), image.sample( px, py+1 ) ] ];
   for ( var k = 0; k < 2; ++k )
   {
      var a = axes[k][0], c = axes[k][1];
      var D = a - 2*b0 + c;
      if ( D < 0 )
      {
         var corr = -(a - c)*(a - c)/(8*D);
         if ( corr > 0 )
            peak += corr;
      }
   }
   if ( peak > 2*b0 )                      // interpolation ran away
      peak = b0;

   if ( peak <= bkg || peak >= 0.98 )      // flat, or saturated
      return -1;

   var half = bkg + 0.5*(peak - bkg);
   var area = 0;
   for ( var yy = y0; yy <= y1; ++yy )
      for ( var xx = x0; xx <= x1; ++xx )
         if ( image.sample( xx, yy ) > half )
            ++area;

   if ( area < 3 )
      return -1;
   if ( area > Math.PI*0.6*R*0.6*R )
      return -2;                           // core fills the box; grow it
   return area;
}

function medianOf( a )
{
   var b = a.slice();
   b.sort( function( x, y ) { return x - y; } );
   var n = b.length;
   return (n & 1) ? b[n >> 1] : 0.5*(b[n/2 - 1] + b[n/2]);
}

/*
 * Median PSF FWHM of a view, in pixels.
 *
 * StarDetector supplies positions; the FWHM itself is measured here rather
 * than through DynamicPSF, so this does not depend on the layout of the psf
 * table. Cross-check the first result against DynamicPSF before trusting it.
 */
function measureFWHM( view, maxStars )
{
   var all;
   try
   {
      var detector = new StarDetector;
      detector.structureLayers = 5;
      detector.noiseLayers = 1;
      detector.hotPixelFilterRadius = 1;
      detector.sensitivity = 0.1;
      detector.peakResponse = 0.8;
      detector.maxDistortion = 0.5;
      detector.upperLimit = 0.95;
      all = detector.stars( view.image );
   }
   catch ( e )
   {
      return { ok: false, reason: "star detection failed (" + e.message + ")" };
   }

   if ( all == null || all.length < 12 )
      return { ok: false,
               reason: format( "only %d stars detected",
                               (all == null) ? 0 : all.length ) };

   // Rank by flux and work down from just below the top: the brightest are
   // saturated or bloated, the faintest give an unreliable peak.
   all.sort( function( a, b ) { return b.flux - a.flux; } );

   var minSep = 24;
   var image = view.image;
   var values = [];
   var start = Math.floor( all.length*0.05 );

   // Spatial hash for the crowding test. A frame this size can hold tens of
   // thousands of stars, and checking every pair would dominate the runtime.
   var grid = {};
   for ( var i = 0; i < all.length; ++i )
   {
      var k = Math.floor( all[i].pos.x/minSep ) + ","
            + Math.floor( all[i].pos.y/minSep );
      if ( grid[k] == null )
         grid[k] = [];
      grid[k].push( i );
   }

   // A companion inside the box would be counted into the half-maximum area.
   function hasNeighbour( idx )
   {
      var s = all[idx];
      var gx = Math.floor( s.pos.x/minSep ), gy = Math.floor( s.pos.y/minSep );
      for ( var dy = -1; dy <= 1; ++dy )
         for ( var dx = -1; dx <= 1; ++dx )
         {
            var bucket = grid[ (gx+dx) + "," + (gy+dy) ];
            if ( bucket == null )
               continue;
            for ( var t = 0; t < bucket.length; ++t )
            {
               if ( bucket[t] == idx )
                  continue;
               var o = all[ bucket[t] ];
               var ex = o.pos.x - s.pos.x, ey = o.pos.y - s.pos.y;
               if ( ex*ex + ey*ey < minSep*minSep )
                  return true;
            }
         }
      return false;
   }

   for ( var i = start; i < all.length && values.length < maxStars; ++i )
   {
      var s = all[i];
      if ( hasNeighbour( i ) )
         continue;

      var R = 8, a = -2;
      while ( a == -2 && R <= 64 )
      {
         a = starArea( image, s.pos.x, s.pos.y, R );
         if ( a == -2 )
            R *= 2;
      }
      if ( a > 0 )
         values.push( a );
   }

   if ( values.length < 8 )
      return { ok: false,
               reason: format( "only %d stars were measurable", values.length ) };

   // Reject outliers on the median, then average the surviving AREAS. Averaging
   // before the square root is what lets the result resolve differences finer
   // than the one-pixel quantum of the area count.
   var med = medianOf( values );
   var dev = [];
   for ( var i = 0; i < values.length; ++i )
      dev.push( Math.abs( values[i] - med ) );
   var mad = medianOf( dev );

   var sum = 0, kept = 0;
   for ( var i = 0; i < values.length; ++i )
      if ( mad <= 0 || Math.abs( values[i] - med ) <= 3*mad )
      {
         sum += values[i];
         ++kept;
      }
   if ( kept < 8 )
      return { ok: false,
               reason: format( "only %d stars survived outlier rejection", kept ) };

   var fwhm = 2*Math.sqrt( (sum/kept)/Math.PI );
   if ( !(fwhm >= 1.0 && fwhm <= 100.0) )
      return { ok: false, reason: format( "implausible result, %.2f px", fwhm ) };

   // Report the scatter as a FWHM-equivalent spread rather than an area spread.
   var scatter = Math.abs( 2*Math.sqrt( Math.max( med + mad, 0 )/Math.PI )
                         - 2*Math.sqrt( Math.max( med - mad, 0 )/Math.PI ) )/2;

   return { ok: true, fwhm: fwhm, count: kept, mad: scatter };
}

// Gaussian-blurred duplicate of a view, used only for signal detection.
function smoothedCopy( view, sigma, id )
{
   var w = new ImageWindow( view.image.width, view.image.height,
                            1, 32, true, false, id );
   w.mainView.beginProcess( UndoFlag_NoSwapFile );
   w.mainView.image.assign( view.image );
   w.mainView.endProcess();

   var C = new Convolution;
   C.mode = Convolution.prototype.Parametric;
   C.sigma = sigma;
   C.shape = 2.00;
   C.aspectRatio = 1.00;
   C.rotationAngle = 0.00;
   C.rescaleHighPass = false;
   C.executeOn( w.mainView );

   return w;
}

/*
 * PixelMath expression producing the BASE weight map for one channel:
 *   s = local significance of the smoothed channel, in its own sigma units
 *   t = s mapped onto [0,1] across the [tLow, tHigh] ramp
 *   result = floor + (1-floor) * smoothstep( t )
 *
 * The per-channel multiplier is deliberately left out here so the map stays
 * inside [0,1] and cannot be clipped when PixelMath truncates. It is applied
 * afterwards as a constant factor in the combination expression.
 */
function weightMapExpression( c, i, p )
{
   var s = "s" + i, t = "t" + i;
   return {
      expression:
         s + " = (" + c.smoothId + " - " + fmt( c.sm ) + ")/" + fmt( c.sg ) + ";\n"
       + t + " = max( 0, min( 1, (" + s + " - " + fmt( p.tLow ) + ")/"
                               + fmt( p.tHigh - p.tLow ) + " ) );\n"
       + fmt( p.weightFloor ) + " + " + fmt( 1 - p.weightFloor )
       + "*" + t + "*" + t + "*(3 - 2*" + t + ")",
      symbols: s + ", " + t
   };
}

// Gaussian blur applied in place to an existing window.
function blurInPlace( view, sigma )
{
   var C = new Convolution;
   C.mode = Convolution.prototype.Parametric;
   C.sigma = sigma;
   C.shape = 2.00;
   C.aspectRatio = 1.00;
   C.rotationAngle = 0.00;
   C.rescaleHighPass = false;
   C.executeOn( view );
}

function dropTemp( temps, win )
{
   for ( var i = 0; i < temps.length; ++i )
      if ( temps[i].mainView.id == win.mainView.id )
      {
         temps.splice( i, 1 );
         break;
      }
   win.forceClose();
}

function runPixelMath( expression, symbols, targetView, newId, rescale )
{
   var P = new PixelMath;
   P.expression = expression;
   P.expression1 = "";
   P.expression2 = "";
   P.expression3 = "";
   P.useSingleExpression = true;
   P.symbols = symbols;
   P.generateOutput = true;
   P.singleThreaded = false;
   P.use64BitWorkingImage = false;
   P.rescale = rescale;
   P.rescaleLower = 0.0;
   P.rescaleUpper = 1.0;
   P.truncate = !rescale;
   P.truncateLower = 0.0;
   P.truncateUpper = 1.0;
   P.createNewImage = true;
   P.showNewImage = false;
   P.newImageId = newId;
   P.newImageWidth = 0;
   P.newImageHeight = 0;
   P.newImageAlpha = false;
   P.newImageColorSpace = PixelMath.prototype.Gray;
   P.newImageSampleFormat = PixelMath.prototype.f32;
   P.executeOn( targetView, false /*swapFile*/ );

   return ImageWindow.windowById( newId );
}

// ----------------------------------------------------------------------------
// Engine
// ----------------------------------------------------------------------------

function buildLuminance( p )
{
   var views = [];
   for ( var i = 0; i < p.viewIds.length; ++i )
   {
      var w = ImageWindow.windowById( p.viewIds[i] );
      if ( w.isNull )
         throw new Error( "No such image: " + p.viewIds[i] );
      views.push( w.mainView );
   }

   var W = views[0].image.width, H = views[0].image.height;
   for ( var i = 0; i < views.length; ++i )
   {
      if ( views[i].image.isColor )
         throw new Error( views[i].id + " is a color image. "
                        + "This script expects monochrome narrowband masters." );
      if ( views[i].image.width != W || views[i].image.height != H )
         throw new Error( "Image geometries differ. " + views[i].id + " is "
                        + views[i].image.width + "x" + views[i].image.height
                        + ", expected " + W + "x" + H
                        + ". Register and crop all channels identically first." );
   }

   Console.show();
   Console.writeln( "<end><cbr><br>=== " + TITLE + " " + VERSION + " ===" );

   var channels = [];
   var temps = [];
   var weightWins = [];

   if ( (p.weightBlur > 0 || p.autoBlur) && p.weightFloor >= 1.0 )
      Console.warningln( "<end><cbr>Weight blur has no effect at a weight floor "
                       + "of 1.00: the weight map is uniform, so there is nothing "
                       + "to smooth. Lower the floor to use it." );

   try
   {
      // --- Structure scale ----------------------------------------------------
      // Measured per channel: two filters can differ in seeing, and each
      // channel's detection map should be smoothed by its own PSF.
      var scales = [];
      for ( var i = 0; i < views.length; ++i )
         scales.push( p.structScale );

      if ( p.autoScale )
      {
         for ( var i = 0; i < views.length; ++i )
         {
            Console.writeln( "<end><cbr>Measuring PSF of " + views[i].id
                           + " (star detection takes a while on large images) ..." );
            Console.flush();

            var r = measureFWHM( views[i], 200 );
            if ( r.ok )
            {
               scales[i] = p.scaleK * r.fwhm;
               Console.noteln( format(
                  "  %s: FWHM %.2f px from %d stars (scatter %.2f px)"
                + " -> structure scale %.2f",
                  views[i].id, r.fwhm, r.count, r.mad, scales[i] ) );
               if ( i == views.length-1 )
                  Console.writeln(
                     "  (FWHM here is the measured half-maximum area of real "
                   + "stars. DynamicPSF reports the width of a fitted Moffat "
                   + "model, which typically reads a few percent narrower. A "
                   + "small difference between the two is expected.)" );
            }
            else
               Console.warningln( "  " + views[i].id + ": " + r.reason
                                + ". Falling back to the manual structure scale of "
                                + format( "%.2f", p.structScale ) + "." );
         }

      }

      var meanScale = 0;
      for ( var i = 0; i < scales.length; ++i )
         meanScale += scales[i];
      meanScale /= scales.length;

      var blur = p.weightBlur;
      if ( p.autoBlur )
      {
         blur = p.blurK * meanScale;
         Console.noteln( format( "<end><cbr>Weight map smoothing: %.2f px "
                               + "(%.2f x the mean structure scale of %.2f).",
                                 blur, p.blurK, meanScale ) );
      }
      else
         Console.writeln( format( "<end><cbr>Weight map smoothing: %.2f px. "
                                + "Suggested for this run: %.2f.",
                                  blur, p.blurK*meanScale ) );

      // --- Per-channel statistics -------------------------------------------
      for ( var i = 0; i < views.length; ++i )
      {
         var v = views[i];
         Console.writeln( "<end><cbr>Analyzing " + v.id + " ..." );
         Console.flush();

         var n = robustNoise( v.image );

         var sid = uniqueId( "_snbl_smooth_" + i );
         var sw = smoothedCopy( v, scales[i], sid );
         temps.push( sw );
         var sn = robustNoise( sw.mainView.image );

         var mult = (p.weights && p.weights[i] > 0) ? p.weights[i] : 1.0;

         var c = {
            view:     v,
            m:        n.location,
            g:        n.scale,
            smoothId: sid,
            sm:       sn.location,
            sg:       sn.scale,
            mult:     mult,
            scale:    scales[i],
            peak:     (v.image.maximum() - n.location)/n.scale
         };

         Console.writeln( format( "  background = %.6f   sigma = %.3e   peak = %.0f sigma"
                                + "   weight x%.2f   structure scale %.2f",
                                  n.location, n.scale, c.peak, mult, c.scale ) );

         // Materialize the weight map so it can be blurred as an image. The
         // detection copy is released immediately afterwards -- the map
         // supersedes it, so peak memory stays at one extra full-size image
         // rather than two.
         var wm = weightMapExpression( c, i, p );
         var wid = uniqueId( p.makeWeightMaps ? ("weight_" + v.id)
                                              : ("_snbl_weight_" + i) );
         var wwin = runPixelMath( wm.expression, wm.symbols, v, wid, false );
         if ( wwin.isNull )
            throw new Error( "Could not build the weight map for " + v.id );
         weightWins.push( wwin );

         dropTemp( temps, sw );

         if ( blur > 0 )
         {
            Console.writeln( format( "  smoothing weight map, sigma %.2f px",
                                     blur ) );
            Console.flush();
            blurInPlace( wwin.mainView, blur );
         }

         c.weightId = wid;
         channels.push( c );
      }

      // --- Relative depth report ---------------------------------------------
      var best = 0;
      for ( var i = 1; i < channels.length; ++i )
         if ( channels[i].peak > channels[best].peak )
            best = i;
      Console.writeln( "<end><cbr><br>Relative depth (peak significance vs. "
                       + channels[best].view.id + "):" );
      for ( var i = 0; i < channels.length; ++i )
         Console.writeln( format( "  %-24s %5.1f %%", channels[i].view.id,
                                  100*channels[i].peak/channels[best].peak ) );

      // --- Assemble the combination expression --------------------------------
      var symbols = [];
      var stmts = [];
      var num = [], den = [];

      for ( var i = 0; i < channels.length; ++i )
      {
         var c = channels[i];
         var nsym = "n" + i;
         // The weight maps are images now, so they enter the expression by id.
         // The multiplier rides along as a constant factor.
         var wref = "(" + fmt( c.mult ) + "*" + c.weightId + ")";
         symbols.push( nsym );
         stmts.push( nsym + " = (" + c.view.id + " - " + fmt( c.m ) + ")/" + fmt( c.g ) );
         num.push( wref + "*" + nsym );
         den.push( wref );
      }
      stmts.push( "(" + num.join( " + " ) + ")/(" + den.join( " + " ) + ")" );

      var expression = stmts.join( ";\n" );

      Console.writeln( "<end><cbr><br>PixelMath expression:" );
      Console.writeln( expression );

      // --- Combine ---------------------------------------------------------------
      var outId = uniqueId( p.outputId );
      var out = runPixelMath( expression, symbols.join( ", " ),
                              channels[0].view, outId, p.rescaleOutput );
      if ( out.isNull )
         throw new Error( "PixelMath produced no output image." );

      out.show();
      out.zoomToFit();

      Console.writeln( "<end><cbr><br>Created " + outId );
      Console.writeln( "Stretch this separately from your color image, then use it "
                     + "as L in LRGBCombination." );

      return out;
   }
   finally
   {
      for ( var i = 0; i < temps.length; ++i )
         if ( p.keepIntermediates )
            temps[i].show();
         else
            temps[i].forceClose();

      for ( var i = 0; i < weightWins.length; ++i )
         if ( p.makeWeightMaps || p.keepIntermediates )
         {
            weightWins[i].show();
            Console.writeln( "Weight map: " + weightWins[i].mainView.id );
         }
         else
            weightWins[i].forceClose();
   }
}

// ----------------------------------------------------------------------------
// Dialog
// ----------------------------------------------------------------------------

function SNBLDialog()
{
   this.__base__ = Dialog;
   this.__base__();

   var labelWidth = this.font.width( "Background weight floor:" ) + 8;
   var self = this;

   // --- Header --------------------------------------------------------------
   this.helpLabel = new Label( this );
   this.helpLabel.frameStyle = FrameStyle_Box;
   this.helpLabel.margin = 6;
   this.helpLabel.wordWrapping = true;
   this.helpLabel.useRichText = true;
   this.helpLabel.text =
      "<b>" + TITLE + " v" + VERSION + "</b><br><br>" +
      "Combines two or more narrowband masters (Ha / OIII / SII) into one " +
      "luminance master. Each channel is first matched to its own noise, then " +
      "weighted per pixel by how strongly it is actually detected there -- so " +
      "a channel lends its signal where it has some, without lending its noise " +
      "where it has none.<br><br>" +
      "<b>Before running:</b> your masters must be <i>linear</i>, registered to " +
      "each other and cropped identically. Do gradient removal and any " +
      "denoising per channel first. Do <b>not</b> LinearFit them -- the noise " +
      "matching here replaces that and does a better job for this purpose." +
      "<br><br>" +
      "<b>After running:</b> stretch the result separately from your colour " +
      "image, then use it as L in LRGBCombination.<br><br>" +
      "Hover any control for an explanation. The defaults are a sound starting " +
      "point on most data; the two automatic options measure what they need " +
      "from your own images.";

   // --- Channel list ---------------------------------------------------------
   this.channels = new TreeBox( this );
   this.channels.alternateRowColor = true;
   this.channels.headerVisible = true;
   this.channels.numberOfColumns = 2;
   this.channels.setHeaderText( 0, "Image" );
   this.channels.setHeaderText( 1, "Weight" );
   this.channels.rootDecoration = false;
   this.channels.setMinSize( 380, 110 );

   this.viewList = new ViewList( this );
   this.viewList.getMainViews();
   this.viewList.toolTip =
      "Pick a narrowband master, then click Add. Repeat for each channel.\n\n" +
      "Two or more channels, all monochrome, all the same size, all still " +
      "linear. Order does not matter.";

   this.addButton = new PushButton( this );
   this.addButton.text = "Add";
   this.addButton.onClick = function()
   {
      var v = self.viewList.currentView;
      if ( v.isNull || v.id.length == 0 )
         return;
      for ( var i = 0; i < self.channels.numberOfChildren; ++i )
         if ( self.channels.child( i ).text( 0 ) == v.id )
            return;
      var node = new TreeBoxNode( self.channels );
      node.setText( 0, v.id );
      node.setText( 1, "1.00" );
   };

   this.removeButton = new PushButton( this );
   this.removeButton.text = "Remove";
   this.removeButton.onClick = function()
   {
      for ( var i = self.channels.numberOfChildren; --i >= 0; )
         if ( self.channels.child( i ).selected )
            self.channels.remove( i );
   };

   this.clearButton = new PushButton( this );
   this.clearButton.text = "Clear";
   this.clearButton.onClick = function() { self.channels.clear(); };

   this.listButtons = new HorizontalSizer;
   this.listButtons.spacing = 6;
   this.listButtons.add( this.viewList, 100 );
   this.listButtons.add( this.addButton );
   this.listButtons.add( this.removeButton );
   this.listButtons.add( this.clearButton );

   this.weightEdit = new NumericEdit( this );
   this.weightEdit.label.text = "Weight:";
   this.weightEdit.setRange( 0.05, 10.0 );
   this.weightEdit.setPrecision( 2 );
   this.weightEdit.setValue( 1.0 );
   this.weightEdit.toolTip =
      "How much you want this channel to dominate the luminance. 1.00 is " +
      "neutral. Select a channel in the list, set a value, click Apply.\n\n" +
      "Every channel is already matched to its own noise before mixing, so " +
      "equal weights give an even blend. This multiplier is where you state a " +
      "preference on top of that.\n\n" +
      "Raise it on the channel carrying the finest detail -- usually Ha -- if " +
      "the result looks flat in regions where two channels overlap. Averaging " +
      "two genuine signals always softens each one, and this is how you decide " +
      "which of them wins. 1.5 to 2.0 is a common range.\n\n" +
      "Know the trade: favouring one channel gives up some of the noise " +
      "reduction an even blend would give you. If one channel is much noisier " +
      "than the others, lowering its weight is also a reasonable use of this.";

   this.applyWeightButton = new PushButton( this );
   this.applyWeightButton.text = "Apply to selected";
   this.applyWeightButton.onClick = function()
   {
      var n = 0;
      for ( var i = 0; i < self.channels.numberOfChildren; ++i )
         if ( self.channels.child( i ).selected )
         {
            self.channels.child( i ).setText( 1,
               format( "%.2f", self.weightEdit.value ) );
            ++n;
         }
      if ( n == 0 )
         (new MessageBox( "Select a channel in the list first.",
                          TITLE, StdIcon_Information, StdButton_Ok )).execute();
   };

   this.weightSizer = new HorizontalSizer;
   this.weightSizer.spacing = 6;
   this.weightSizer.add( this.weightEdit );
   this.weightSizer.add( this.applyWeightButton );
   this.weightSizer.addStretch();

   this.channelsGroup = new GroupBox( this );
   this.channelsGroup.title = "Channels";
   this.channelsGroup.sizer = new VerticalSizer;
   this.channelsGroup.sizer.margin = 6;
   this.channelsGroup.sizer.spacing = 6;
   this.channelsGroup.sizer.add( this.channels );
   this.channelsGroup.sizer.add( this.listButtons );
   this.channelsGroup.sizer.add( this.weightSizer );

   // --- Numeric parameters ----------------------------------------------------
   this.tLow = new NumericControl( this );
   this.tLow.label.text = "Background below:";
   this.tLow.label.minWidth = labelWidth;
   this.tLow.setRange( 0.0, 10.0 );
   this.tLow.slider.setRange( 0, 200 );
   this.tLow.setPrecision( 2 );
   this.tLow.setValue( params.tLow );
   this.tLow.toolTip =
      "Where a channel counts as empty.\n\n" +
      "Measured in sigma, meaning multiples of that channel's own noise. At " +
      "1.5, a channel whose local brightness sits less than 1.5x its noise " +
      "above its own background is treated as having nothing here, and its " +
      "weight drops to the floor set below.\n\n" +
      "Raise it if noise is being mistaken for faint signal. Lower it to let " +
      "very faint structure count. 1.0 to 2.0 suits most data.\n\n" +
      "Because it is expressed in each channel's own noise, this setting " +
      "carries across datasets, cameras and targets without adjustment.";
   this.tLow.onValueUpdated = function( v ) { params.tLow = v; };

   this.tHigh = new NumericControl( this );
   this.tHigh.label.text = "Full signal above:";
   this.tHigh.label.minWidth = labelWidth;
   this.tHigh.setRange( 0.5, 30.0 );
   this.tHigh.slider.setRange( 0, 200 );
   this.tHigh.setPrecision( 2 );
   this.tHigh.setValue( params.tHigh );
   this.tHigh.toolTip =
      "Where a channel counts as fully present.\n\n" +
      "Also in sigma. At or above this, the channel gets full weight. Between " +
      "the two thresholds the weight follows a smooth S-curve, so there are no " +
      "hard edges.\n\n" +
      "Lowering it admits weaker signal from your fainter channel -- but it " +
      "brings that channel's noise with it, and it lets the faint channel " +
      "reach full weight inside bright parts of the stronger one, where " +
      "averaging the two will soften the stronger channel's detail.\n\n" +
      "Raising it is the conservative direction: only well-detected structure " +
      "counts. 3 to 8 covers most cases; 5 is a sound starting point.";
   this.tHigh.onValueUpdated = function( v ) { params.tHigh = v; };

   this.structScale = new NumericControl( this );
   this.structScale.label.text = "Structure scale (px):";
   this.structScale.label.minWidth = labelWidth;
   this.structScale.setRange( 0.5, 64.0 );
   this.structScale.slider.setRange( 0, 200 );
   this.structScale.setPrecision( 2 );
   this.structScale.setValue( params.structScale );
   this.structScale.toolTip =
      "Only used when the automatic measurement above is switched off.\n\n" +
      "How much to blur each channel before deciding where it has signal. This " +
      "blur is used only for that decision; it never touches your output " +
      "pixels.\n\n" +
      "Set it to roughly your star FWHM in pixels -- measure a dozen stars " +
      "with DynamicPSF and use the average. Note the box wants a Gaussian " +
      "sigma, and entering your FWHM here is deliberate: it makes the filter " +
      "wider than one tuned to find stars, which is what nebulosity needs.\n\n" +
      "Too small and the decision is driven by noise instead of structure; on " +
      "drizzled data it will read the interpolation between pixels as signal. " +
      "Too large and the edge between nebulosity and sky smears.\n\n" +
      "There is no universally correct number -- it depends on your pixel " +
      "scale, your seeing and whether you drizzled, since drizzling spreads " +
      "the same star over more pixels. That is exactly why the automatic " +
      "option exists.";
   this.structScale.onValueUpdated = function( v ) { params.structScale = v; };

   this.weightFloor = new NumericControl( this );
   this.weightFloor.label.text = "Background weight floor:";
   this.weightFloor.label.minWidth = labelWidth;
   this.weightFloor.setRange( 0.0, 1.0 );
   this.weightFloor.slider.setRange( 0, 100 );
   this.weightFloor.setPrecision( 3 );
   this.weightFloor.setValue( params.weightFloor );
   this.weightFloor.toolTip =
      "How much a channel still contributes where it has no detected signal.\n\n" +
      "At 0.15 an empty channel keeps 15% of its weight: low enough not to " +
      "dilute the channel that does have signal there, high enough that the " +
      "handover between them stays smooth.\n\n" +
      "0 shuts an empty channel out entirely. That is the cleanest separation, " +
      "but the abrupt change can print visible edges in the result.\n\n" +
      "1.00 turns the adaptive behaviour off altogether: every pixel gets the " +
      "same mix and the script becomes a plain noise-matched blend at whatever " +
      "ratio you set in the Weight column. That is a legitimate and very safe " +
      "way to run it.\n\n" +
      "In empty sky all channels sit at the floor together, so the result " +
      "there is a straight average -- which is the lowest-noise option.";
   this.weightFloor.onValueUpdated = function( v ) { params.weightFloor = v; };

   this.autoScaleCheck = new CheckBox( this );
   this.autoScaleCheck.text = "Measure the PSF and set structure scale from it";
   this.autoScaleCheck.checked = params.autoScale;
   this.autoScaleCheck.toolTip =
      "Measures your star size in each channel and sets the detection scale " +
      "from it, instead of you typing a number. Recommended, and on by " +
      "default.\n\n" +
      "The right detection scale depends on your pixel scale, your seeing and " +
      "whether you drizzled, so a number that suits one dataset will be wrong " +
      "for the next. Measuring it removes that trap. It is done separately per " +
      "channel, since filters are often shot on different nights in different " +
      "conditions.\n\n" +
      "The console prints the measured FWHM, how many stars were used and the " +
      "scatter between them. This is its own measurement of the real stars, " +
      "not a copy of DynamicPSF -- it measures the actual area above half " +
      "maximum, where DynamicPSF reports the width of a fitted model, so " +
      "expect it to read a few percent wider. That difference is normal.\n\n" +
      "If star detection fails or returns something implausible, the manual " +
      "value below is used instead and the console says so.";
   this.autoScaleCheck.onCheck = function( c )
   {
      params.autoScale = c;
      self.structScale.enabled = !c;
      self.scaleK.enabled = c;
   };

   this.scaleK = new NumericControl( this );
   this.scaleK.label.text = "Scale = k x FWHM:";
   this.scaleK.label.minWidth = labelWidth;
   this.scaleK.setRange( 0.25, 4.0 );
   this.scaleK.slider.setRange( 0, 150 );
   this.scaleK.setPrecision( 2 );
   this.scaleK.setValue( params.scaleK );
   this.scaleK.enabled = params.autoScale;
   this.scaleK.toolTip =
      "How wide to make the signal-detection filter, in units of your own " +
      "measured star size.\n\n" +
      "1.00 sets the filter to your FWHM. That is deliberately wider than a " +
      "filter tuned to find stars, because what you are detecting here is " +
      "nebulosity, which is broader than a point of light.\n\n" +
      "Lower it toward 0.5 to favour small, compact structure. Raise it toward " +
      "2 for very faint large-scale emission, at the cost of blurring the " +
      "boundary between signal and background.\n\n" +
      "Leave it at 1.00 unless you have a specific reason. Measuring your star " +
      "size is something the script can do; deciding what you are looking for " +
      "is not, which is why this stays in your hands.";
   this.scaleK.onValueUpdated = function( v ) { params.scaleK = v; };

   this.structScale.enabled = !params.autoScale;

   this.weightBlur = new NumericControl( this );
   this.weightBlur.label.text = "Weight map smoothing:";
   this.weightBlur.label.minWidth = labelWidth;
   this.weightBlur.setRange( 0.0, 64.0 );
   this.weightBlur.slider.setRange( 0, 200 );
   this.weightBlur.setPrecision( 2 );
   this.weightBlur.setValue( params.weightBlur );
   this.weightBlur.toolTip =
      "Only used when the automatic setting above is switched off.\n\n" +
      "How much to smooth the weight map before it is applied, in pixels. " +
      "0 disables smoothing.\n\n" +
      "Why it matters: around a star, a channel's weight falls from full to " +
      "the floor across a narrow ring, and at a different radius in each " +
      "channel -- so the blend between them swings one way and then back " +
      "within a few pixels, printing a dark halo. The same thing happens along " +
      "every nebular edge, where it quietly costs you contrast rather than " +
      "showing up as an obvious artifact.\n\n" +
      "Set it to roughly twice your detection scale. Too little leaves rings " +
      "around stars; too much dilutes faint signal.\n\n" +
      "Has no effect when the weight floor is 1.00, because the map is uniform " +
      "and there is nothing to smooth.";
   this.weightBlur.onValueUpdated = function( v ) { params.weightBlur = v; };

   this.autoBlurCheck = new CheckBox( this );
   this.autoBlurCheck.text = "Set weight map smoothing from the structure scale";
   this.autoBlurCheck.checked = params.autoBlur;
   this.autoBlurCheck.toolTip =
      "Ties the weight map smoothing to the detection scale, so the two stay " +
      "in step when one changes. Recommended, and on by default.\n\n" +
      "Works whether the detection scale was measured or typed in. The console " +
      "always prints the value actually used.";
   this.autoBlurCheck.onCheck = function( c )
   {
      params.autoBlur = c;
      self.weightBlur.enabled = !c;
      self.blurK.enabled = c;
   };

   this.blurK = new NumericControl( this );
   this.blurK.label.text = "Smoothing = k x scale:";
   this.blurK.label.minWidth = labelWidth;
   this.blurK.setRange( 0.5, 8.0 );
   this.blurK.slider.setRange( 0, 150 );
   this.blurK.setPrecision( 2 );
   this.blurK.setValue( params.blurK );
   this.blurK.enabled = params.autoBlur;
   this.blurK.toolTip =
      "How far to spread out the weight transitions, in units of the detection " +
      "scale.\n\n" +
      "2.00 is a good default: it spreads each transition over about twice the " +
      "scale at which signal was detected, which is enough to stop the weight " +
      "map printing edges of its own onto your image.\n\n" +
      "Raise it if you still see rings or halos around stars. Lower it if " +
      "faint regions start looking washed out, which means a channel's weight " +
      "is bleeding into areas where it has nothing to contribute.";
   this.blurK.onValueUpdated = function( v ) { params.blurK = v; };

   this.weightBlur.enabled = !params.autoBlur;

   this.paramsGroup = new GroupBox( this );
   this.paramsGroup.title = "Adaptive weighting";
   this.paramsGroup.sizer = new VerticalSizer;
   this.paramsGroup.sizer.margin = 6;
   this.paramsGroup.sizer.spacing = 6;
   this.paramsGroup.sizer.add( this.tLow );
   this.paramsGroup.sizer.add( this.tHigh );
   this.paramsGroup.sizer.add( this.autoScaleCheck );
   this.paramsGroup.sizer.add( this.scaleK );
   this.paramsGroup.sizer.add( this.structScale );
   this.paramsGroup.sizer.add( this.weightFloor );
   this.paramsGroup.sizer.add( this.autoBlurCheck );
   this.paramsGroup.sizer.add( this.blurK );
   this.paramsGroup.sizer.add( this.weightBlur );

   // --- Output ----------------------------------------------------------------
   this.outputIdLabel = new Label( this );
   this.outputIdLabel.text = "Output image:";
   this.outputIdLabel.minWidth = labelWidth;
   this.outputIdLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;

   this.outputIdEdit = new Edit( this );
   this.outputIdEdit.text = params.outputId;
   this.outputIdEdit.onEditCompleted = function()
   {
      params.outputId = this.text.trim();
   };

   this.outputIdSizer = new HorizontalSizer;
   this.outputIdSizer.spacing = 6;
   this.outputIdSizer.add( this.outputIdLabel );
   this.outputIdSizer.add( this.outputIdEdit, 100 );

   this.rescaleCheck = new CheckBox( this );
   this.rescaleCheck.text = "Rescale output to [0,1]";
   this.rescaleCheck.checked = params.rescaleOutput;
   this.rescaleCheck.toolTip =
      "Leave this on.\n\n" +
      "Internally the channels are mixed in units of noise, not brightness, so " +
      "the raw result is not on the usual 0-1 scale. This rescales it back to a " +
      "normal linear image you can stretch like any other master.";
   this.rescaleCheck.onCheck = function( c ) { params.rescaleOutput = c; };

   this.weightMapCheck = new CheckBox( this );
   this.weightMapCheck.text = "Also create weight maps (diagnostic)";
   this.weightMapCheck.checked = params.makeWeightMaps;
   this.weightMapCheck.toolTip =
      "Produces one extra image per channel showing where that channel was " +
      "used: white means it contributed fully, dark means it was held back.\n\n" +
      "Worth switching on the first time you run a new dataset. If the result " +
      "looks wrong, these tell you whether the cause is the settings or the " +
      "data. They are the smoothed maps actually used, so what you see is what " +
      "the script did.";
   this.weightMapCheck.onCheck = function( c ) { params.makeWeightMaps = c; };

   this.keepCheck = new CheckBox( this );
   this.keepCheck.text = "Keep smoothed intermediates";
   this.keepCheck.checked = params.keepIntermediates;
   this.keepCheck.toolTip =
      "Keeps the blurred working copies instead of discarding them. Only " +
      "useful for troubleshooting -- they take up memory and are not needed " +
      "for anything downstream.";
   this.keepCheck.onCheck = function( c ) { params.keepIntermediates = c; };

   this.outputGroup = new GroupBox( this );
   this.outputGroup.title = "Output";
   this.outputGroup.sizer = new VerticalSizer;
   this.outputGroup.sizer.margin = 6;
   this.outputGroup.sizer.spacing = 6;
   this.outputGroup.sizer.add( this.outputIdSizer );
   this.outputGroup.sizer.add( this.rescaleCheck );
   this.outputGroup.sizer.add( this.weightMapCheck );
   this.outputGroup.sizer.add( this.keepCheck );

   // --- Buttons ----------------------------------------------------------------
   this.okButton = new PushButton( this );
   this.okButton.text = "Run";
   this.okButton.icon = this.scaledResource( ":/icons/ok.png" );
   this.okButton.onClick = function()
   {
      params.viewIds = [];
      params.weights = [];
      for ( var i = 0; i < self.channels.numberOfChildren; ++i )
      {
         params.viewIds.push( self.channels.child( i ).text( 0 ) );
         var wv = parseFloat( self.channels.child( i ).text( 1 ) );
         params.weights.push( (wv > 0) ? wv : 1.0 );
      }

      if ( params.viewIds.length < 2 )
      {
         (new MessageBox( "Add at least two channels.",
                          TITLE, StdIcon_Error, StdButton_Ok )).execute();
         return;
      }
      if ( params.tHigh <= params.tLow )
      {
         (new MessageBox( "Full signal above must be greater than Background below.",
                          TITLE, StdIcon_Error, StdButton_Ok )).execute();
         return;
      }
      if ( params.outputId.length == 0 )
         params.outputId = "SynthL";

      self.ok();
   };

   this.cancelButton = new PushButton( this );
   this.cancelButton.text = "Cancel";
   this.cancelButton.icon = this.scaledResource( ":/icons/cancel.png" );
   this.cancelButton.onClick = function() { self.cancel(); };

   this.buttonsSizer = new HorizontalSizer;
   this.buttonsSizer.spacing = 6;
   this.buttonsSizer.addStretch();
   this.buttonsSizer.add( this.okButton );
   this.buttonsSizer.add( this.cancelButton );

   // --- Layout ------------------------------------------------------------------
   this.sizer = new VerticalSizer;
   this.sizer.margin = 8;
   this.sizer.spacing = 8;
   this.sizer.add( this.helpLabel );
   this.sizer.add( this.channelsGroup );
   this.sizer.add( this.paramsGroup );
   this.sizer.add( this.outputGroup );
   this.sizer.add( this.buttonsSizer );

   this.windowTitle = TITLE + " v" + VERSION;
   this.adjustToContents();
   this.setMinWidth( this.width );
}

SNBLDialog.prototype = new Dialog;

// ----------------------------------------------------------------------------
// Entry point
// ----------------------------------------------------------------------------

function main()
{
   if ( ImageWindow.openWindows.length < 2 )
   {
      (new MessageBox( "Open at least two registered narrowband masters first.",
                       TITLE, StdIcon_Error, StdButton_Ok )).execute();
      return;
   }

   var dialog = new SNBLDialog;
   if ( !dialog.execute() )
      return;

   try
   {
      buildLuminance( params );
   }
   catch ( error )
   {
      Console.criticalln( error.message );
      (new MessageBox( error.message, TITLE, StdIcon_Error, StdButton_Ok )).execute();
   }
}

main();
