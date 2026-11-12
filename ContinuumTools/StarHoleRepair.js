// ----------------------------------------------------------------------------
// Star Hole Repair - ContinuumTools
// ----------------------------------------------------------------------------
//
// Finds the dark holes that over-subtracted stars leave in continuum-
// subtracted images and fills them from their surroundings, optionally
// guided by a starless narrowband image. A star reference image restricts
// the repair to holes that actually have a star at their centre.
//
// See README.md for details.
// ----------------------------------------------------------------------------

#engine v8

#feature-id    StarHoleRepair : ContinuumTools > Star Hole Repair

#feature-info  Repairs dark star holes left by continuum subtraction.<br/>\
   <br/>\
   Detects compact dark holes, keeps those with a star at their centre (from a \
   star reference image) and fills them from their surroundings or from a \
   starless guide image.

#include "lib/CTCore.js"
#include "lib/CTRepair.js"
#include "lib/SHREngine.js"
#include "lib/SHRDialog.js"

function main()
{
   if ( ImageWindow.windows.length < 1 )
   {
      CT.errorBox( "Open the image to repair first (and, ideally, an image with stars as reference).",
                   "Star Hole Repair" );
      return;
   }
   console.show();
   console.abortEnabled = true;
   let dialog = new SHRDialog();
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
