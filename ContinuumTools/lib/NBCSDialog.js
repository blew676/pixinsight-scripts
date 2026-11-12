// ----------------------------------------------------------------------------
// ContinuumTools - Narrowband Continuum Subtraction dialog
// ----------------------------------------------------------------------------

var NBCSDialog = class extends Dialog
{
   constructor()
   {
      super();
      let self = this;
      this.p = CT.loadSettings( NBCS.TOOL, NBCS.defaults() );
      this.p.k = 0;                    // always re-measured for new data
      this.cache = new NBCS.Cache();
      this.busy = false;

      this.windowTitle = "Narrowband Continuum Subtraction";
      this.userResizable = true;
      let lw = this.font.width( "Continuum starless:" ) + 16;

      // --- header ----------------------------------------------------------
      this.help = CT.ui.infoLabel( this,
         "<b>Narrowband Continuum Subtraction " + CT.VERSION + "</b><br/>" +
         "Removes the continuum (starlight, dust, reflection) from a narrowband image " +
         "using a broadband image. The scale factor is measured from <i>stars</i> on the " +
         "images with stars; the subtraction is done on <i>starless</i> versions, so no " +
         "black holes or rings are created. Inputs must be linear and registered." );
      this.help.frameStyle = FrameStyle.Box;
      this.help.margin = 6;
      this.help.setScaledMinWidth( 440 );

      // --- inputs ----------------------------------------------------------
      this.nbList = CT.ui.viewList( this,
         "<p>The narrowband master WITH stars (H-alpha, OIII or SII), linear.</p>",
         function() { self.inputsChanged( true ); } );
      this.bbList = CT.ui.viewList( this,
         "<p>The broadband master WITH stars that carries the continuum, linear and " +
         "registered to the narrowband image: R for H-alpha / SII, G or B for OIII. " +
         "A color image can be used; pick the channel below.</p>",
         function() { self.inputsChanged( true ); } );
      this.chCombo = new ComboBox( this );
      this.chCombo.addItem( "Red" );
      this.chCombo.addItem( "Green" );
      this.chCombo.addItem( "Blue" );
      this.chCombo.currentItem = Math.round( this.p.bbChannel );
      this.chCombo.toolTip = "<p>Channel of a color continuum image to use (ignored for mono images).</p>";
      this.chCombo.onItemSelected = function( i ) { self.p.bbChannel = i; self.inputsChanged( true ); };

      this.inputsGroup = CT.ui.group( this, "Images with stars (linear, registered)", [
         CT.ui.labeledRow( this, "Narrowband:", lw, this.nbList ),
         CT.ui.labeledRow( this, "Continuum:", lw, this.bbList ),
         CT.ui.row( [ CT.ui.label( this, "Channel:", lw ), this.chCombo, "stretch" ] )
      ] );

      // --- star removal ----------------------------------------------------
      this.starlessRadio = new RadioButton( this );
      this.starlessRadio.text = "Subtract starless images (recommended)";
      this.starlessRadio.checked = this.p.starless;
      this.starlessRadio.toolTip = "<p>The continuum is subtracted using starless versions of both " +
         "images. Leave the starless selectors empty to generate them with StarXTerminator " +
         "(once per session; the scale factor still comes from the images with stars).</p>";
      this.starlessRadio.onCheck = function( c ) { if ( c ) { self.p.starless = true; self.inputsChanged( false ); } };
      this.starredRadio = new RadioButton( this );
      this.starredRadio.text = "Subtract the images with stars";
      this.starredRadio.checked = !this.p.starless;
      this.starredRadio.toolTip = "<p>Plain subtraction with stars present. Stars whose color differs " +
         "from the average leave rings or dark holes. Use only when star removal is not possible.</p>";
      this.starredRadio.onCheck = function( c ) { if ( c ) { self.p.starless = false; self.inputsChanged( false ); } };

      let slTip = "<p>Optional. A starless version of the image above (e.g. from StarXTerminator or " +
                  "StarNet). Leave as &lt;No view selected&gt; to generate one automatically.</p>";
      this.nbSLList = CT.ui.viewList( this, slTip, function() { self.inputsChanged( false ); } );
      this.bbSLList = CT.ui.viewList( this, slTip, function() { self.inputsChanged( false ); } );
      this.addStarsCheck = CT.ui.check( this, "Keep the narrowband stars", this.p.addStars,
         function( v ) { self.p.addStars = v; self.inputsChanged( false ); },
         "<p>Subtract the starless continuum from the narrowband image <i>with</i> stars. The " +
         "result keeps the narrowband's own (natural, artifact-free) stars. Off: the result is starless.</p>" );
      this.keepCheck = CT.ui.check( this, "Keep generated starless images open", this.p.keepStarless,
         function( v ) { self.p.keepStarless = v; },
         "<p>Starless images generated with StarXTerminator are shown when the dialog closes, so they " +
         "can be reused (for example as the guide image in StarHoleRepair).</p>" );

      this.starGroup = CT.ui.group( this, "Star removal", [
         this.starlessRadio,
         CT.ui.labeledRow( this, "Narrowband starless:", lw, this.nbSLList ),
         CT.ui.labeledRow( this, "Continuum starless:", lw, this.bbSLList ),
         CT.ui.row( [ CT.ui.label( this, "", lw ), this.addStarsCheck, "stretch" ] ),
         CT.ui.row( [ CT.ui.label( this, "", lw ), this.keepCheck, "stretch" ] ),
         this.starredRadio
      ] );

      // --- scale factor ----------------------------------------------------
      this.kControl = CT.ui.numeric( this, "Scale factor k:", lw, 0, 1.5, 4, this.p.k,
         function( v ) { self.p.k = v; self.schedulePreview(); },
         "<p>Fraction of the continuum image subtracted from the narrowband image. Measured from " +
         "stars (pure continuum). Larger values remove more; too large darkens the nebula and " +
         "eats faint emission, too small leaves stars and dust glow.</p>" );
      this.measureButton = CT.ui.button( this, "Measure from stars", function() { self.doMeasure(); },
         "<p>Aperture photometry of isolated, unsaturated stars in both images with stars. k is the " +
         "median flux ratio narrowband / continuum.</p>" );
      this.measureInfo = CT.ui.infoLabel( this, "Not measured yet." );
      this.cControl = CT.ui.numeric( this, "Line in continuum c:", lw, 0, 1, 3, this.p.c,
         function( v ) { self.p.c = v; self.schedulePreview(); },
         "<p>Optional flux correction: the fraction of the emission line recorded by the broadband " +
         "filter, relative to the narrowband filter (roughly broadband exposure / narrowband exposure, " +
         "more if the broadband filter also passes [NII]). The result is multiplied by 1/(1 - k&middot;c). " +
         "It only changes the overall brightness, so 0 is fine unless the result must stay " +
         "photometrically calibrated.</p>" );

      this.kGroup = CT.ui.group( this, "Scale factor", [
         this.kControl,
         CT.ui.row( [ CT.ui.label( this, "", lw ), this.measureButton, "stretch" ] ),
         this.measureInfo,
         this.cControl
      ] );

      // --- buttons ---------------------------------------------------------
      this.runButton = CT.ui.button( this, "Create image", function() { self.doRun(); },
         "<p>Create the continuum-subtracted image at full resolution as a new image window.</p>" );
      this.closeButton = CT.ui.button( this, "Close", function() { self.cancel(); } );
      this.status = CT.ui.infoLabel( this, "" );

      this.left = new VerticalSizer;
      this.left.spacing = 6;
      this.left.add( this.help );
      this.left.add( this.inputsGroup );
      this.left.add( this.starGroup );
      this.left.add( this.kGroup );
      this.left.addStretch();
      this.left.add( this.status );
      this.left.add( CT.ui.row( [ this.runButton, "stretch", this.closeButton ] ) );

      // --- preview ---------------------------------------------------------
      this.preview = new CT.PreviewControl( this );
      this.preview.message = "Press 'Update preview'";
      this.previewButton = CT.ui.button( this, "Update preview", function() { self.doPreview(); },
         "<p>Prepares the images (runs StarXTerminator if needed) and shows the result. Afterwards the " +
         "preview follows the k slider live.</p>" );
      this.stretchButton = CT.ui.button( this, "Auto-stretch", function() { self.renderPreview( true ); },
         "<p>Recompute the preview display stretch. The stretch is otherwise kept fixed while k " +
         "changes, so over- or under-subtraction stays visible.</p>" );
      this.fitButton = CT.ui.button( this, "Fit", function() { self.preview.fit(); } );
      this.right = new VerticalSizer;
      this.right.spacing = 4;
      this.right.add( this.preview, 100 );
      this.right.add( CT.ui.row( [ this.previewButton, this.stretchButton, this.fitButton, "stretch" ] ) );

      this.sizer = new HorizontalSizer;
      this.sizer.margin = 8;
      this.sizer.spacing = 8;
      this.sizer.add( this.left );
      this.sizer.add( this.right, 100 );

      this.timer = new Timer;
      this.timer.interval = 0.15;
      this.timer.periodic = false;
      this.timer.onTimeout = function() { self.renderPreview( false ); };

      this.updateEnabled();
      this.adjustToContents();
      this.setScaledMinSize( 1150, 720 );
   }

   // --- state -------------------------------------------------------------

   views()
   {
      return { nb: this.nbList.currentView, bb: this.bbList.currentView,
               nbSL: this.nbSLList.currentView, bbSL: this.bbSLList.currentView };
   }

   inputsChanged( resetK )
   {
      if ( resetK )
      {
         this.p.k = 0;
         this.kControl.setValue( 0 );
         this.measureInfo.text = "Not measured yet.";
      }
      this.cache.preview = null;
      this.preview.clear( "Press 'Update preview'" );
      this.updateEnabled();
   }

   updateEnabled()
   {
      let v = this.views();
      let ok = CT.isView( v.nb ) && CT.isView( v.bb );
      this.chCombo.enabled = CT.isView( v.bb ) && v.bb.image.numberOfChannels > 1;
      this.nbSLList.enabled = this.bbSLList.enabled = this.addStarsCheck.enabled =
         this.keepCheck.enabled = this.p.starless;
      this.measureButton.enabled = ok && !this.busy;
      this.previewButton.enabled = ok && !this.busy;
      this.runButton.enabled = ok && !this.busy;
      this.stretchButton.enabled = !!this.cache.preview && !this.busy;
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

   // --- actions -----------------------------------------------------------

   doMeasure()
   {
      let self = this;
      this.guard( function()
      {
         let v = self.views();
         self.setBusy( true, "Measuring stars..." );
         let m = NBCS.measure( v.nb, v.bb, self.p );
         self.p.k = m.k;
         self.kControl.setValue( m.k );
         self.measureInfo.text = format( "k = %.4f from %d stars (middle half %.4f - %.4f). " +
            "Star FWHM %.1f / %.1f px.", m.k, m.n, m.p25, m.p75, m.fwhmNB, m.fwhmBB );
         self.status.text = "";
         if ( self.cache.preview )
            self.renderPreview( false );
      } );
   }

   ensureK()
   {
      if ( !( this.p.k > 0 ) )
      {
         let v = this.views();
         let m = NBCS.measure( v.nb, v.bb, this.p );
         this.p.k = m.k;
         this.kControl.setValue( m.k );
         this.measureInfo.text = format( "k = %.4f from %d stars (middle half %.4f - %.4f).", m.k, m.n, m.p25, m.p75 );
      }
   }

   doPreview()
   {
      let self = this;
      this.guard( function()
      {
         let v = self.views();
         self.setBusy( true, "Measuring stars..." );
         self.ensureK();
         self.setBusy( true, self.p.starless ? "Preparing starless images (StarXTerminator may take a minute)..." :
                                               "Loading images..." );
         NBCS.prepare( self.cache, v.nb, v.bb, v.nbSL, v.bbSL, self.p );
         NBCS.previewSetup( self.cache, 1600, 1100 );
         self.renderPreview( true );
         self.status.text = "Preview ready. Drag the k slider to see the effect.";
      } );
   }

   schedulePreview()
   {
      if ( this.cache.preview && !this.busy )
      {
         this.timer.stop();
         this.timer.start();
      }
   }

   renderPreview( restretch )
   {
      if ( !this.cache.preview )
         return;
      try
      {
         let bmp = NBCS.previewBitmap( this.cache, this.p, restretch );
         this.preview.setBitmap( bmp, this.cache.preview.f, true );
      }
      catch ( e )
      {
         CT.warn( "Preview failed: " + e );
      }
   }

   doRun()
   {
      let self = this;
      this.guard( function()
      {
         let v = self.views();
         self.setBusy( true, "Measuring stars..." );
         self.ensureK();
         self.setBusy( true, self.p.starless ? "Preparing starless images..." : "Loading images..." );
         NBCS.prepare( self.cache, v.nb, v.bb, v.nbSL, v.bbSL, self.p );
         self.setBusy( true, "Subtracting..." );
         let win = NBCS.execute( self.cache, v.nb, v.bb, v.nbSL, v.bbSL, self.p );
         self.status.text = "Created " + win.mainView.id + ".";
      } );
   }

   cleanup()
   {
      this.timer.stop();
      CT.saveSettings( NBCS.TOOL, { bbChannel: this.p.bbChannel, c: this.p.c, starless: this.p.starless,
                                    addStars: this.p.addStars, keepStarless: this.p.keepStarless } );
      this.cache.release( this.p.keepStarless );
   }
};
