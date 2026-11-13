// ----------------------------------------------------------------------------
// Add Narrowband to RGB - ContinuumTools
// ----------------------------------------------------------------------------
//
// Adds stretched, continuum-subtracted narrowband images (H-alpha, OIII, SII)
// to a stretched RGB/LRGB image with a soft, non-clipping addition, blended
// into R, G and B by per-line weights. The defaults reproduce these PixelMath
// recipes exactly (W = the channel's weight):
//
//    $T * ~W + W * mtf( ~m, mtf( m, $T ) + mtf( m, NB ) ),  m = 0.999
//    H-alpha: R 1.0, G 0.0, B 0.05      OIII: R 0.0, G 1.0, B 1.5
//
// See README.md for details.
// ----------------------------------------------------------------------------

#engine v8

#feature-id    AddNarrowbandToRGB : ContinuumTools > Add Narrowband to RGB

#feature-info  Adds narrowband data to a stretched RGB image.<br/>\
   <br/>\
   Soft, non-clipping addition of continuum-subtracted H-alpha, OIII and SII \
   images, blended into R, G and B by per-line weights, with a live preview.

#include "lib/CTCore.js"
#include "lib/NBAddEngine.js"
#include "lib/NBAddDialog.js"

function main()
{
   if ( ImageWindow.windows.length < 2 )
   {
      CT.errorBox( "Open the stretched RGB image and at least one stretched, continuum-subtracted " +
                   "narrowband image first.", "Add Narrowband to RGB" );
      return;
   }
   console.show();
   console.abortEnabled = true;
   let dialog = new NBAddDialog();
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
