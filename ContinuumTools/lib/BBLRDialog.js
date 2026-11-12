// ----------------------------------------------------------------------------
// ContinuumTools - Broadband Line Removal dialog
// ----------------------------------------------------------------------------

var BBLRDialog = class extends Dialog
{
   constructor()
   {
      super();
      let self = this;
      this.p = CT.loadSettings( BBLR.TOOL, BBLR.defaults() );
      this.data = null;
      this.busy = false;
      this.showOriginal = false;

      this.windowTitle = "Broadband Line Removal";
      this.userResizable = true;
      let lw = this.font.width( "Broadband exposure (s):" ) + 16;

      this.help = CT.ui.infoLabel( this,
         "<b>Broadband Line Removal " + CT.VERSION + "</b><br/>" +
         "Removes emission-line light from broadband images so only the continuum is left: " +
         "stars, reflection nebulae, dust. The line images are continuum-subtracted narrowband " +
         "images (the output of Narrowband Continuum Subtraction, preferably starless). " +
         "Adjust the amounts until the bright emission fronts vanish without leaving a dark imprint." );
      this.help.frameStyle = FrameStyle.Box;
      this.help.margin = 6;
      this.help.setScaledMinWidth( 440 );

      // --- inputs ----------------------------------------------------------
      this.targetList = CT.ui.viewList( this,
         "<p>Linear broadband image to clean: a mono R/G/B master or an RGB image. Stars may be present " +
         "(they are left untouched when the line images are starless).</p>",
         function() { self.inputsChanged(); } );
      this.monoCombo = new ComboBox( this );
      this.monoCombo.addItem( "Red filter" );
      this.monoCombo.addItem( "Green filter" );
      this.monoCombo.addItem( "Blue filter" );
      this.monoCombo.currentItem = Math.round( this.p.monoFilter );
      this.monoCombo.toolTip = "<p>For a mono target: which broadband filter it was taken through.</p>";
      this.monoCombo.onItemSelected = function( i ) { self.p.monoFilter = i; self.updateRows(); self.schedulePreview(); };
      this.haList = CT.ui.viewList( this,
         "<p>Continuum-subtracted H-alpha image (linear, starless recommended), registered to the target.</p>",
         function() { self.inputsChanged(); } );
      this.o3List = CT.ui.viewList( this,
         "<p>Optional continuum-subtracted OIII image, for the G and B channels.</p>",
         function() { self.inputsChanged(); } );

      this.inputsGroup = CT.ui.group( this, "Images (linear, registered)", [
         CT.ui.labeledRow( this, "Broadband:", lw, this.targetList ),
         CT.ui.row( [ CT.ui.label( this, "Mono target filter:", lw ), this.monoCombo, "stretch" ] ),
         CT.ui.labeledRow( this, "Hα line image:", lw, this.haList ),
         CT.ui.labeledRow( this, "OIII line image:", lw, this.o3List )
      ] );

      // --- amounts ---------------------------------------------------------
      this.amountControls = {};
      let amountItems = [];
      for ( let r of BBLR.ROWS )
      {
         let key = r.key;
         let ctl = CT.ui.numeric( this, r.label + ":", lw, 0, 2, 4, this.p[key],
            function( v ) { self.p[key] = v; self.schedulePreview(); },
            "<p>Amount of the line image subtracted from this channel.</p>" );
         this.amountControls[key] = ctl;
         amountItems.push( ctl );
      }
      this.amountInfo = CT.ui.infoLabel( this, "" );
      amountItems.push( this.amountInfo );
      this.amountGroup = CT.ui.group( this, "Amounts", amountItems );

      // --- estimates -------------------------------------------------------
      let num = function( text, key, min, max, prec, tip )
      {
         let e = new NumericEdit( self );
         e.label.text = text;
         e.label.minWidth = lw;
         e.setRange( min, max );
         e.setPrecision( prec );
         e.setValue( self.p[key] );
         e.toolTip = tip;
         e.onValueUpdated = function( v ) { self.p[key] = v; };
         return e;
      };
      this.tBBEdit = num( "Broadband exposure (s):", "tBB", 0, 100000, 1,
         "<p>Sub-exposure time of the broadband master (read from EXPTIME/EXPOSURE when present).</p>" );
      this.tHaEdit = num( "Hα exposure (s):", "tHa", 0, 100000, 1, "<p>Sub-exposure time of the H-alpha master.</p>" );
      this.tO3Edit = num( "OIII exposure (s):", "tO3", 0, 100000, 1, "<p>Sub-exposure time of the OIII master.</p>" );
      this.fHaREdit = num( "F  R ← Hα:", "fHaR", 0, 10, 3,
         "<p>Filter factor: H-alpha light in the R filter relative to the H-alpha filter, including the " +
         "[NII] lines a wide R filter passes and a 3 nm H-alpha filter mostly rejects. 1.3 - 1.5 for " +
         "3 nm filters; closer to 1.1 for 7 nm filters.</p>" );
      this.fO3GEdit = num( "F  G ← OIII:", "fO3G", 0, 10, 3,
         "<p>OIII 500.7 nm is near the blue edge of most G filters: 0 - 1 depending on the filter " +
         "(Optolong/Antlia G pass part of it).</p>" );
      this.fO3BEdit = num( "F  B ← OIII:", "fO3B", 0, 10, 3, "<p>OIII inside the B filter: about 1.</p>" );
      this.fHaBEdit = num( "F  B ← Hβ:", "fHaB", 0, 10, 3,
         "<p>H-beta relative to H-alpha: 0.35 without extinction, lower with dust (0.2 - 0.3 typical).</p>" );
      this.physButton = CT.ui.button( this, "From exposures", function() { self.doPhysics(); },
         "<p>Starting amounts from exposure times and filter factors: (t_BB / t_NB) &times; F, corrected " +
         "for the continuum factor used to make the line image.</p>" );
      this.imageButton = CT.ui.button( this, "From image", function() { self.doImageEstimate(); },
         "<p>Estimates the amounts from the image itself (lower envelope of broadband versus line " +
         "brightness). Dust that correlates with emission can bias it; check in the preview.</p>" );
      this.estGroup = CT.ui.group( this, "Starting values", [
         this.tBBEdit, this.tHaEdit, this.tO3Edit, this.fHaREdit, this.fO3GEdit, this.fO3BEdit, this.fHaBEdit,
         CT.ui.row( [ CT.ui.label( this, "", lw ), this.physButton, this.imageButton, "stretch" ] )
      ] );

      // --- buttons ---------------------------------------------------------
      this.runButton = CT.ui.button( this, "Create image", function() { self.doRun(); },
         "<p>Create the line-free broadband image at full resolution.</p>" );
      this.closeButton = CT.ui.button( this, "Close", function() { self.cancel(); } );
      this.status = CT.ui.infoLabel( this, "" );

      this.left = new VerticalSizer;
      this.left.spacing = 6;
      this.left.add( this.help );
      this.left.add( this.inputsGroup );
      this.left.add( this.amountGroup );
      this.left.add( this.estGroup );
      this.left.addStretch();
      this.left.add( this.status );
      this.left.add( CT.ui.row( [ this.runButton, "stretch", this.closeButton ] ) );

      // --- preview ---------------------------------------------------------
      this.preview = new CT.PreviewControl( this );
      this.preview.message = "Press 'Update preview'";
      this.previewButton = CT.ui.button( this, "Update preview", function() { self.doPreview(); },
         "<p>Loads the images and shows the result; it then follows the amount sliders live. The " +
         "display stretch is taken from the original broadband image, so removed light shows as dimming.</p>" );
      this.originalCheck = CT.ui.check( this, "Show original", false,
         function( v ) { self.showOriginal = v; self.renderPreview(); },
         "<p>Toggle to compare with the untouched broadband image.</p>" );
      this.fitButton = CT.ui.button( this, "Fit", function() { self.preview.fit(); } );
      this.right = new VerticalSizer;
      this.right.spacing = 4;
      this.right.add( this.preview, 100 );
      this.right.add( CT.ui.row( [ this.previewButton, this.originalCheck, this.fitButton, "stretch" ] ) );

      this.sizer = new HorizontalSizer;
      this.sizer.margin = 8;
      this.sizer.spacing = 8;
      this.sizer.add( this.left );
      this.sizer.add( this.right, 100 );

      this.timer = new Timer;
      this.timer.interval = 0.15;
      this.timer.periodic = false;
      this.timer.onTimeout = function() { self.renderPreview(); };

      this.updateRows();
      this.updateEnabled();
      this.adjustToContents();
      this.setScaledMinSize( 1150, 760 );
   }

   views()
   {
      return { target: this.targetList.currentView, ha: this.haList.currentView, o3: this.o3List.currentView };
   }

   isColorTarget()
   {
      let v = this.views();
      return CT.isView( v.target ) && v.target.image.numberOfChannels >= 3;
   }

   updateRows()
   {
      let v = this.views();
      let rows = BBLR.activeRows( this.isColorTarget(), this.p, true, true );
      let active = {};
      for ( let r of rows ) active[r.key] = true;
      for ( let r of BBLR.ROWS )
      {
         let ctl = this.amountControls[r.key];
         let hasLine = r.line == 0 ? CT.isView( v.ha ) : CT.isView( v.o3 );
         ctl.visible = !!active[r.key];
         ctl.enabled = hasLine;
      }
      this.monoCombo.enabled = CT.isView( v.target ) && !this.isColorTarget();
      this.amountInfo.text = rows.length == 0 ? "No line applies to this filter." : "";
   }

   inputsChanged()
   {
      let v = this.views();
      let t = CT.exposureOf( v.target ), th = CT.exposureOf( v.ha ), to = CT.exposureOf( v.o3 );
      if ( t ) { this.p.tBB = t; this.tBBEdit.setValue( t ); }
      if ( th ) { this.p.tHa = th; this.tHaEdit.setValue( th ); }
      if ( to ) { this.p.tO3 = to; this.tO3Edit.setValue( to ); }
      this.data = null;
      this.preview.clear( "Press 'Update preview'" );
      this.updateRows();
      this.updateEnabled();
   }

   updateEnabled()
   {
      let v = this.views();
      let ok = CT.isView( v.target ) && ( CT.isView( v.ha ) || CT.isView( v.o3 ) );
      this.previewButton.enabled = ok && !this.busy;
      this.runButton.enabled = ok && !this.busy;
      this.imageButton.enabled = ok && !this.busy;
      this.physButton.enabled = ok && !this.busy;
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

   ensureData()
   {
      let v = this.views();
      let ids = [ CT.isView( v.target ) ? v.target.id : "", CT.isView( v.ha ) ? v.ha.id : "", CT.isView( v.o3 ) ? v.o3.id : "" ].join( "|" );
      if ( this.data && this.data.ids == ids )
         return this.data;
      this.setBusy( true, "Loading images..." );
      this.data = BBLR.load( v.target, v.ha, v.o3 );
      return this.data;
   }

   setAmounts( est )
   {
      let n = 0;
      for ( let key in est )
      {
         this.p[key] = est[key];
         this.amountControls[key].setValue( est[key] );
         ++n;
      }
      return n;
   }

   doPhysics()
   {
      let self = this;
      this.guard( function()
      {
         let d = self.ensureData();
         let rows = BBLR.activeRows( d.color, self.p, !!d.lines[0], !!d.lines[1] );
         let est = BBLR.physicsEstimate( self.p, rows, d.kHa, d.kO3 );
         let n = self.setAmounts( est );
         self.status.text = n > 0 ? "Amounts set from exposures and filter factors." :
                                    "Enter the exposure times first.";
         self.renderPreview();
      } );
   }

   doImageEstimate()
   {
      let self = this;
      this.guard( function()
      {
         let d = self.ensureData();
         self.setBusy( true, "Estimating from the image..." );
         let rows = BBLR.activeRows( d.color, self.p, !!d.lines[0], !!d.lines[1] );
         let est = {}, txt = [];
         for ( let r of rows )
         {
            if ( r.key == "aB_Ha" )
               continue;   // H-beta is mixed with OIII in B; keep the physics value
            let ch = d.color ? r.ch : 0;
            let a = BBLR.imageEstimate( d.bb[ch], d.lines[r.line], d.W, d.H, d.L0[r.line] );
            est[r.key] = a;
            txt.push( r.label + " " + CT.fmt( a, 3 ) );
         }
         self.setAmounts( est );
         self.status.text = "Image estimate: " + txt.join( ", " ) + ". Fine-tune in the preview.";
         self.renderPreview();
      } );
   }

   doPreview()
   {
      let self = this;
      this.guard( function()
      {
         let d = self.ensureData();
         self.setBusy( true, "Preparing preview..." );
         BBLR.previewSetup( d, 1600, 1100 );
         self.renderPreview();
         self.status.text = "Preview ready. Adjust the amounts; toggle 'Show original' to compare.";
      } );
   }

   schedulePreview()
   {
      if ( this.data && this.data.preview && !this.busy )
      {
         this.timer.stop();
         this.timer.start();
      }
   }

   renderPreview()
   {
      if ( !this.data || !this.data.preview )
         return;
      try
      {
         let bmp = BBLR.previewBitmap( this.data, this.p, this.showOriginal );
         this.preview.setBitmap( bmp, this.data.preview.f, true );
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
         let d = self.ensureData();
         self.setBusy( true, "Removing line light..." );
         let win = BBLR.execute( d, v.target, self.p );
         self.status.text = "Created " + win.mainView.id + ".";
      } );
   }

   cleanup()
   {
      this.timer.stop();
      let s = {};
      for ( let k of [ "monoFilter", "fHaR", "fO3G", "fO3B", "fHaB" ] )
         s[k] = this.p[k];
      CT.saveSettings( BBLR.TOOL, s );
      this.data = null;
   }
};
