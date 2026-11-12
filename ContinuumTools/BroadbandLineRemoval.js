// ----------------------------------------------------------------------------
// Broadband Line Removal - ContinuumTools
// ----------------------------------------------------------------------------
//
// Removes emission-line light (H-alpha, [NII], OIII, H-beta) from broadband
// images using continuum-subtracted narrowband images, leaving the continuum:
// stars, reflection nebulae, dust and IFN.
//
// See README.md for details.
// ----------------------------------------------------------------------------

#engine v8

#feature-id    BroadbandLineRemoval : ContinuumTools > Broadband Line Removal

#feature-info  Removes emission-line light from broadband images.<br/>\
   <br/>\
   Subtracts scaled continuum-subtracted narrowband images (H-alpha, OIII) \
   from R, G and B to reveal dust and reflection nebulae.

#include "lib/CTCore.js"
#include "lib/BBLREngine.js"
#include "lib/BBLRDialog.js"

function main()
{
   if ( ImageWindow.windows.length < 2 )
   {
      CT.errorBox( "Open the broadband image and at least one continuum-subtracted line image " +
                   "(for example the output of Narrowband Continuum Subtraction) first.",
                   "Broadband Line Removal" );
      return;
   }
   console.show();
   console.abortEnabled = true;
   let dialog = new BBLRDialog();
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
