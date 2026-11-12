// ----------------------------------------------------------------------------
// Narrowband Continuum Subtraction - ContinuumTools
// ----------------------------------------------------------------------------
//
// Removes the continuum from a narrowband master (H-alpha, OIII, SII) using a
// broadband master. The scale factor is measured from stars on the images
// with stars; the subtraction is applied to starless versions (generated with
// StarXTerminator when not supplied), so no dark star holes are produced.
//
// See README.md for details.
// ----------------------------------------------------------------------------

#engine v8

#feature-id    NarrowbandContinuumSubtraction : ContinuumTools > Narrowband Continuum Subtraction

#feature-info  Continuum subtraction for narrowband data.<br/>\
   <br/>\
   Measures the continuum scale factor from stars and subtracts the continuum \
   using starless images, avoiding the dark holes left by over-subtracted stars.

#include "lib/CTCore.js"
#include "lib/NBCSEngine.js"
#include "lib/NBCSDialog.js"

function main()
{
   if ( ImageWindow.windows.length < 2 )
   {
      CT.errorBox( "Open the narrowband and the broadband (continuum) masters first. " +
                   "Both must be linear and registered to each other.", "Narrowband Continuum Subtraction" );
      return;
   }
   console.show();
   console.abortEnabled = true;
   let dialog = new NBCSDialog();
   try
   {
      dialog.execute();
   }
   finally
   {
      dialog.cleanup();
   }
}

main();
