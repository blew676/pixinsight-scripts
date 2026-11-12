// ----------------------------------------------------------------------------
// ContinuumTools - Star Hole Repair dialog
// ----------------------------------------------------------------------------

var SHRDialog = class extends Dialog
{
   constructor()
   {
      super();
      let self = this;
      this.p = CT.loadSettings( SHR.TOOL, SHR.defaults() );
      this.s = null;
      this.busy = false;
      this.showRepaired = false;

      this.windowTitle = "Star Hole Repair";
      this.userResizable = true;
      let lw = this.font.width( "Star brightness check:" ) + 16;

      this.help = CT.ui.infoLabel( this,
         "<b>Star Hole Repair " + CT.VERSION + "</b><br/>" +
         "Finds the dark holes left where stars were over-subtracted (continuum subtraction) and " +
         "fills them from their surroundings. With a <i>star reference</i> only holes that have a " +
         "star at their centre are repaired, so real dark nebulae are left alone. A starless " +
         "<i>guide</i> image (e.g. H-alpha starless) supplies the nebula structure under each star. " +
         "Click a circle in the preview to include or exclude it." );
      this.help.frameStyle = FrameStyle.Box;
      this.help.margin = 6;
      this.help.setScaledMinWidth( 440 );

      // --- images ----------------------------------------------------------
      this.targetList = CT.ui.viewList( this,
         "<p>The image with dark holes: linear or stretched, mono or color.</p>",
         function() { self.inputsChanged(); } );
      this.refList = CT.ui.viewList( this,
         "<p>Recommended. An image WITH stars, registered to the target (for example the R or H-alpha " +
         "master). Holes are only repaired where a star sits at their centre and is bright enough to " +
         "explain the hole size.</p>",
         function() { self.inputsChanged(); } );
      this.guideList = CT.ui.viewList( this,
         "<p>Optional. A starless image showing the nebula under the stars (for example the H-alpha " +
         "starless image). The fill follows its structure, fitted locally to the target's brightness. " +
         "Without a guide the holes are filled smoothly from their surroundings with matching texture.</p>",
         function() { self.inputsChanged(); } );
      this.imagesGroup = CT.ui.group( this, "Images", [
         CT.ui.labeledRow( this, "Target:", lw, this.targetList ),
         CT.ui.labeledRow( this, "Star reference:", lw, this.refList ),
         CT.ui.labeledRow( this, "Guide (starless):", lw, this.guideList )
      ] );

      // --- detection -------------------------------------------------------
      let P = this.p;
      let mk = function( text, key, min, max, prec, tip, after )
      {
         return CT.ui.numeric( self, text, lw, min, max, prec, P[key],
            function( v ) { P[key] = v; self.paramsChanged( after ); }, tip );
      };
      this.cRadius = mk( "Max hole radius (px):", "maxRadius", 5, 120, 0,
         "<p>Largest hole radius searched for. Must exceed the biggest hole (bright stars).</p>", "detect" );
      this.cThreshold = mk( "Threshold (sigma):", "threshold", 2, 40, 1,
         "<p>How much darker than its surroundings a pixel must be, in noise units, to start a hole.</p>", "detect" );
      this.cDepth = mk( "Relative depth:", "depth", 0, 0.95, 2,
         "<p>Minimum darkening relative to the local level (0.4 = at least 40% darker).</p>", "detect" );
      this.cContrast = mk( "Minimum contrast:", "contrast", 0, 2, 2,
         "<p>Minimum hole depth as a fraction of the image's median level above black. Raises the bar " +
         "in very dark areas where holes are invisible anyway.</p>", "detect" );
      this.cCore = mk( "Core near black:", "coreLevel", 0, 1, 2,
         "<p>Over-subtracted holes are clipped to (near) black. The darkest point of a hole must be " +
         "within this fraction of the local level above black. 1 disables the test (use for linear, " +
         "unclipped data).</p>", "detect" );
      this.cStarScale = mk( "Star brightness check:", "starScale", 0, 50, 1,
         "<p>A hole's size scales with the brightness of its star: the star peak (in noise units) must " +
         "exceed this value &times; radius&sup2;. Rejects dark nebulae that merely contain a faint star. " +
         "0 disables it.</p>", "detect" );
      this.cStarSigma = mk( "Star detection (sigma):", "starSigma", 3, 60, 1,
         "<p>Detection threshold for stars in the star reference image.</p>", "detect" );
      this.requireStarCheck = CT.ui.check( this, "Only repair holes with a star", P.requireStar,
         function( v ) { P.requireStar = v; self.paramsChanged( "detect" ); },
         "<p>With a star reference: repair only holes with a star at the centre. Without a reference " +
         "the shape tests are stricter.</p>" );
      this.detectGroup = CT.ui.group( this, "Detection", [
         this.cRadius, this.cThreshold, this.cDepth, this.cContrast, this.cCore, this.cStarScale, this.cStarSigma,
         CT.ui.row( [ CT.ui.label( this, "", lw ), this.requireStarCheck, "stretch" ] )
      ] );

      // --- repair ----------------------------------------------------------
      this.cGrowFrac = mk( "Grow (fraction of r):", "growFrac", 0, 1.5, 2,
         "<p>Repair radius = hole radius &times; (1 + this) + the extra pixels below. Covers the dark " +
         "ring and bright rim around the clipped core.</p>", "repair" );
      this.cGrowPx = mk( "Grow (px):", "growPx", 0, 30, 0, "<p>Extra pixels added to every repair radius.</p>", "repair" );
      this.cFeather = mk( "Feather (px):", "feather", 0, 20, 1, "<p>Width of the soft blend into the original.</p>", "repair" );
      this.textureCheck = CT.ui.check( this, "Add matching texture", P.texture,
         function( v ) { P.texture = v; self.paramsChanged( "repair" ); },
         "<p>Adds fine texture borrowed from a clean nearby patch so fills are not smoother than " +
         "their surroundings.</p>" );
      this.newImageCheck = CT.ui.check( this, "Create a new image", P.newImage,
         function( v ) { P.newImage = v; },
         "<p>On: the result is a new image. Off: the target is modified (undoable).</p>" );
      this.maskCheck = CT.ui.check( this, "Also create the repair mask", P.makeMask,
         function( v ) { P.makeMask = v; } );
      this.repairGroup = CT.ui.group( this, "Repair", [
         this.cGrowFrac, this.cGrowPx, this.cFeather,
         CT.ui.row( [ CT.ui.label( this, "", lw ), this.textureCheck, "stretch" ] ),
         CT.ui.row( [ CT.ui.label( this, "", lw ), this.newImageCheck, "stretch" ] ),
         CT.ui.row( [ CT.ui.label( this, "", lw ), this.maskCheck, "stretch" ] )
      ] );

      // --- buttons ---------------------------------------------------------
      this.detectButton = CT.ui.button( this, "Detect", function() { self.doDetect(); },
         "<p>Find the holes and show them in the preview: green = will be repaired, red = left alone.</p>" );
      this.repairPreviewButton = CT.ui.button( this, "Preview repair", function() { self.doRepairPreview(); },
         "<p>Repair at full resolution and show the result (not applied until 'Apply').</p>" );
      this.runButton = CT.ui.button( this, "Apply", function() { self.doRun(); },
         "<p>Create the repaired image (or modify the target).</p>" );
      this.closeButton = CT.ui.button( this, "Close", function() { self.cancel(); } );
      this.status = CT.ui.infoLabel( this, "" );
      this.countInfo = CT.ui.infoLabel( this, "" );

      this.left = new VerticalSizer;
      this.left.spacing = 6;
      this.left.add( this.help );
      this.left.add( this.imagesGroup );
      this.left.add( this.detectGroup );
      this.left.add( this.repairGroup );
      this.left.addStretch();
      this.left.add( this.countInfo );
      this.left.add( this.status );
      this.left.add( CT.ui.row( [ this.detectButton, this.repairPreviewButton, this.runButton, "stretch", this.closeButton ] ) );

      // --- preview ---------------------------------------------------------
      this.preview = new CT.PreviewControl( this );
      this.preview.message = "Press 'Detect'";
      this.preview.overlay = function( g, ctl ) { self.drawOverlay( g, ctl ); };
      this.preview.onImageClick = function( x, y ) { self.toggleAt( x, y ); };
      this.repairedCheck = CT.ui.check( this, "Show repaired", false,
         function( v ) { self.showRepaired = v; self.renderPreview(); },
         "<p>Toggle between the original and the repaired preview.</p>" );
      this.circlesCheck = CT.ui.check( this, "Show circles", true,
         function( v ) { self.preview.repaint(); } );
      this.rejectedCheck = CT.ui.check( this, "Show rejected", P.showRejected,
         function( v ) { P.showRejected = v; self.preview.repaint(); } );
      this.fitButton = CT.ui.button( this, "Fit", function() { self.preview.fit(); } );
      this.right = new VerticalSizer;
      this.right.spacing = 4;
      this.right.add( this.preview, 100 );
      this.right.add( CT.ui.row( [ this.repairedCheck, this.circlesCheck, this.rejectedCheck, this.fitButton, "stretch" ] ) );

      this.sizer = new HorizontalSizer;
      this.sizer.margin = 8;
      this.sizer.spacing = 8;
      this.sizer.add( this.left );
      this.sizer.add( this.right, 100 );

      this.updateEnabled();
      this.adjustToContents();
      this.setScaledMinSize( 1200, 800 );
   }

   views()
   {
      return { target: this.targetList.currentView, ref: this.refList.currentView, guide: this.guideList.currentView };
   }

   inputsChanged()
   {
      this.s = null;
      this.showRepaired = false;
      this.repairedCheck.checked = false;
      this.preview.clear( "Press 'Detect'" );
      this.countInfo.text = "";
      this.updateEnabled();
   }

   // Parameter changes invalidate detection or just the repair result.
   paramsChanged( what )
   {
      if ( !this.s )
         return;
      if ( what == "detect" && this.s.det )
      {
         this.s.det = null;
         this.s.result = null;
         this.countInfo.text = "Detection parameters changed: press 'Detect' again.";
      }
      else if ( what == "repair" && this.s.result )
      {
         this.s.result = null;
         if ( this.s.preview ) this.s.preview.repaired = null;
         this.countInfo.text = this.countText() + " Repair parameters changed: 'Preview repair' to update.";
      }
      this.preview.repaint();
   }

   updateEnabled()
   {
      let v = this.views();
      let ok = CT.isView( v.target );
      this.detectButton.enabled = ok && !this.busy;
      this.repairPreviewButton.enabled = ok && !this.busy;
      this.runButton.enabled = ok && !this.busy;
      this.requireStarCheck.enabled = CT.isView( v.ref );
      this.cStarScale.enabled = this.cStarSigma.enabled = CT.isView( v.ref );
   }

   setBusy( b, msg )
   {
      this.busy = b;
      this.status.text = msg || "";
      this.updateEnabled();
      CT.yieldUI();
   }

   guard( fn )
   {
      try
      {
         fn();
      }
      catch ( e )
      {
         this.setBusy( false, "" );
         CT.errorBox( String( e.message || e ), this.windowTitle );
         return false;
      }
      this.setBusy( false, this.status.text );
      return true;
   }

   ensureSession()
   {
      let v = this.views();
      let ids = [ CT.isView( v.target ) ? v.target.id : "", CT.isView( v.ref ) ? v.ref.id : "",
                  CT.isView( v.guide ) ? v.guide.id : "" ].join( "|" );
      if ( this.s && this.s.ids == ids )
         return this.s;
      this.setBusy( true, "Loading images..." );
      this.s = SHR.load( v.target, v.ref, v.guide );
      SHR.previewSetup( this.s, 3100, 2100 );
      return this.s;
   }

   countText()
   {
      if ( !this.s || !this.s.det )
         return "";
      let c = SHR.counts( this.s );
      return c.accepted + " holes will be repaired, " + c.rejected + " candidates left alone.";
   }

   doDetect()
   {
      let self = this;
      this.guard( function()
      {
         let s = self.ensureSession();
         self.setBusy( true, "Detecting holes..." );
         SHR.detect( s, self.p );
         s.preview.repaired = null;
         self.showRepaired = false;
         self.repairedCheck.checked = false;
         self.renderPreview();
         self.countInfo.text = self.countText() + " Click circles to toggle.";
         self.status.text = "";
      } );
   }

   doRepairPreview()
   {
      let self = this;
      this.guard( function()
      {
         let s = self.ensureSession();
         if ( !s.det )
         {
            self.setBusy( true, "Detecting holes..." );
            SHR.detect( s, self.p );
         }
         self.setBusy( true, "Repairing..." );
         SHR.repair( s, self.p );
         SHR.previewRepaired( s );
         self.showRepaired = true;
         self.repairedCheck.checked = true;
         self.renderPreview();
         self.countInfo.text = self.countText();
         self.status.text = s.result.repaired + " holes repaired (preview). Press 'Apply' to keep.";
      } );
   }

   doRun()
   {
      let self = this;
      this.guard( function()
      {
         let v = self.views();
         let s = self.ensureSession();
         if ( !s.det )
         {
            self.setBusy( true, "Detecting holes..." );
            SHR.detect( s, self.p );
         }
         if ( !s.result )
         {
            self.setBusy( true, "Repairing..." );
            SHR.repair( s, self.p );
            SHR.previewRepaired( s );
         }
         self.setBusy( true, "Writing result..." );
         let win = SHR.output( s, v.target, self.p );
         self.status.text = ( self.p.newImage ? "Created " : "Repaired " ) + win.mainView.id + ".";
         if ( !self.p.newImage )
            self.s = null;   // target changed: reload next time
      } );
   }

   toggleAt( x, y )
   {
      if ( !this.s || !this.s.det || this.busy )
         return;
      let b = SHR.pick( this.s, this.p, x, y, 4 * this.s.preview.f );
      if ( !b )
         return;
      b.accepted = !b.accepted;
      this.s.result = null;
      this.s.preview.repaired = null;
      if ( this.showRepaired )
      {
         this.showRepaired = false;
         this.repairedCheck.checked = false;
         this.renderPreview();
      }
      this.countInfo.text = this.countText() + " (selection changed)";
      this.preview.repaint();
   }

   renderPreview()
   {
      if ( !this.s || !this.s.preview )
         return;
      let bmp = SHR.previewBitmap( this.s, this.showRepaired );
      this.preview.setBitmap( bmp, this.s.preview.f, true );
   }

   drawOverlay( g, ctl )
   {
      if ( !this.s || !this.s.det || !this.circlesCheck.checked )
         return;
      let f = this.s.preview.f;
      let w = Math.max( 0.5, 1.5 / ctl.zoom );
      let penA = new Pen( 0xff30e050, w ), penR = new Pen( 0xffff4040, w );
      g.antialiasing = true;
      for ( let b of this.s.det.blobs )
      {
         if ( !b.accepted && !this.p.showRejected )
            continue;
         g.pen = b.accepted ? penA : penR;
         g.drawCircle( b.cx / f, b.cy / f, Math.max( 2, CTRepair.repairRadius( b, this.p ) / f ) );
      }
   }

   cleanup()
   {
      let s = {};
      for ( let k of [ "maxRadius", "threshold", "depth", "contrast", "coreLevel", "starScale", "starSigma",
                       "requireStar", "growFrac", "growPx", "feather", "texture", "newImage", "makeMask", "showRejected" ] )
         s[k] = this.p[k];
      CT.saveSettings( SHR.TOOL, s );
      this.s = null;
   }
};
