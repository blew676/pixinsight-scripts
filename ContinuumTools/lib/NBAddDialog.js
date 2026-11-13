// ----------------------------------------------------------------------------
// ContinuumTools - Add Narrowband to RGB dialog
// ----------------------------------------------------------------------------

var NBAddDialog = class extends Dialog
{
   constructor()
   {
      super();
      let self = this;
      this.p = CT.loadSettings( NBADD.TOOL, NBADD.defaults() );
      this.d = null;
      this.busy = false;
      this.showOriginal = false;

      this.windowTitle = "Add Narrowband to RGB";
      this.userResizable = true;
      let lw = this.font.width( "Black point:" ) + 16;

      this.help = CT.ui.infoLabel( this,
         "<b>Add Narrowband to RGB " + CT.VERSION + "</b><br/>" +
         "Adds stretched, continuum-subtracted narrowband images to a stretched RGB image. Each " +
         "line is added with a soft addition that never clips highlights, then blended into R, G " +
         "and B by its weights. The defaults reproduce the Hα and OIII PixelMath recipes " +
         "exactly. All images must be registered to each other." );
      this.help.frameStyle = FrameStyle.Box;
      this.help.margin = 6;
      this.help.setScaledMinWidth( 460 );

      this.targetList = CT.ui.viewList( this,
         "<p>The stretched (non-linear) RGB or LRGB image.</p>",
         function() { self.inputsChanged(); } );

      // --- one group per line ----------------------------------------------
      this.lineUI = {};
      let groups = [];
      for ( let L of NBADD.LINES )
      {
         let key = L.key;
         let ui = {};
         ui.list = CT.ui.viewList( this,
            "<p>Stretched, continuum-subtracted " + L.label + " image (mono). Leave empty to skip " +
            L.label + ".</p>",
            function() { self.inputsChanged(); } );
         let weight = function( ch, name )
         {
            let e = new NumericEdit( self );
            e.label.text = name;
            e.setRange( -1, 4 );
            e.setPrecision( 3 );
            e.setValue( self.p[key + "_" + ch] );
            e.toolTip = "<p>How much of the " + L.label + " addition goes into " + name.replace( ":", "" ) +
               ": 1 = all, 0 = none, above 1 = extra (stronger tint), below 0 = takes it away.</p>";
            e.onValueUpdated = function( v ) { self.p[key + "_" + ch] = v; self.schedulePreview(); };
            return e;
         };
         ui.r = weight( "r", "R:" );
         ui.g = weight( "g", "G:" );
         ui.b = weight( "b", "B:" );
         ui.strength = CT.ui.numeric( this, "Strength:", lw, 0, 3, 2, this.p[key + "_strength"],
            function( v ) { self.p[key + "_strength"] = v; self.schedulePreview(); },
            "<p>Scales the narrowband signal inside the soft addition. 1 = the original PixelMath. " +
            "Unlike the R/G/B weights it changes how bright the addition is without changing its color.</p>" );
         ui.black = CT.ui.numeric( this, "Black point:", lw, 0, 0.5, 4, this.p[key + "_black"],
            function( v ) { self.p[key + "_black"] = v; self.schedulePreview(); },
            "<p>Narrowband level treated as 'no signal'. Anything the narrowband image has in its " +
            "background is otherwise added to the RGB background as a tint (red for Hα, teal " +
            "for OIII). 0 = the original PixelMath.</p>" );
         ui.auto = CT.ui.button( this, "Auto", function() { self.doAutoBlack( key ); },
            "<p>Set the black point to the level of the narrowband image's darkest areas.</p>" );
         ui.lum = CT.ui.numeric( this, "Luminance:", lw, 0, 3, 2, this.p[key + "_lum"],
            function( v ) { self.p[key + "_lum"] = v; self.schedulePreview(); },
            "<p>Adds " + L.label + " to the image's <i>lightness</i> only, with the same soft addition, " +
            "keeping hue and saturation. Brighter, crisper " + L.label + " structure without more " +
            "color than the weights above give. 0 = off.</p>" );
         ui.detail = CT.ui.numeric( this, "Detail:", lw, 0, 1, 2, this.p[key + "_detail"],
            function( v ) { self.p[key + "_detail"] = v; self.schedulePreview(); },
            "<p>Where " + L.label + " is strong, rebuilds the image's fine lightness structure (and its " +
            "noise) from the cleaner " + L.label + " image, matched to the image's own local brightness. " +
            "Only noise-sized differences are replaced, so stars and features " + L.label +
            " does not have are left alone. 1 = full replacement where " + L.label + " is strong. " +
            "Judge it in the 1:1 crop preview. 0 = off.</p>" );
         ui.reset = CT.ui.button( this, "Defaults", function() { self.resetLine( key ); },
            "<p>Restore this line's default weights, strength and black point.</p>" );
         let weightsRow = CT.ui.row( [ CT.ui.label( this, "Weights:", lw ), ui.r, ui.g, ui.b, "stretch", ui.reset ], 8 );
         let blackRow = new HorizontalSizer;
         blackRow.spacing = 4;
         blackRow.add( ui.black, 100 );
         blackRow.add( ui.auto );
         ui.group = CT.ui.group( this, L.label, [
            CT.ui.labeledRow( this, "Image:", lw, ui.list ),
            weightsRow, ui.strength, blackRow, ui.lum, ui.detail
         ] );
         this.lineUI[key] = ui;
         groups.push( ui.group );
      }

      // --- shared ------------------------------------------------------------
      this.mControl = CT.ui.numeric( this, "m:", lw, 0.5, 0.9999, 4, this.p.m,
         function( v ) { self.p.m = v; self.schedulePreview(); },
         "<p>Highlight protection, the m of the PixelMath. 0.999 (the original): the images are " +
         "added in a space where faint signal adds almost linearly and nothing can pass white, so " +
         "bright areas and stars roll off smoothly. 0.5: a plain addition that clips. In between: " +
         "softer or harder roll-off.</p>" );
      this.newImageCheck = CT.ui.check( this, "Create a new image", this.p.newImage,
         function( v ) { self.p.newImage = v; },
         "<p>On: the result opens as a new image. Off: the target itself is changed, like " +
         "PixelMath on $T (undoable). Either way an active mask on the target is honored.</p>" );
      this.radiusControl = CT.ui.numeric( this, "Detail radius:", lw, 1, 12, 0, this.p.detailRadius,
         function( v ) { self.p.detailRadius = Math.round( v ); self.schedulePreview(); },
         "<p>Window radius (px) of the detail rebuild. Small (2-3) replaces only pixel-scale noise " +
         "and fine texture; larger also takes over coarser structure from the narrowband image.</p>" );
      this.sharedGroup = CT.ui.group( this, "Blend", [
         this.mControl, this.radiusControl,
         CT.ui.row( [ CT.ui.label( this, "", lw ), this.newImageCheck, "stretch" ] )
      ] );

      this.runButton = CT.ui.button( this, "Apply", function() { self.doRun(); },
         "<p>Apply at full resolution.</p>" );
      this.closeButton = CT.ui.button( this, "Close", function() { self.cancel(); } );
      this.status = CT.ui.infoLabel( this, "" );

      this.left = new VerticalSizer;
      this.left.spacing = 6;
      this.left.add( this.help );
      this.left.add( CT.ui.labeledRow( this, "RGB image:", lw, this.targetList ) );
      for ( let g of groups )
         this.left.add( g );
      this.left.add( this.sharedGroup );
      this.left.addStretch();
      this.left.add( this.status );
      this.left.add( CT.ui.row( [ this.runButton, "stretch", this.closeButton ] ) );

      // --- preview ---------------------------------------------------------
      this.cropMode = false;
      this.preview = new CT.PreviewControl( this );
      this.preview.message = "Press 'Update preview'";
      this.preview.onImageClick = function( x, y ) { self.clickPreview( x, y ); };
      this.previewButton = CT.ui.button( this, "Update preview", function() { self.doPreview(); },
         "<p>Load the images and show the result; it then follows every control live.</p>" );
      this.originalCheck = CT.ui.check( this, "Show original", false,
         function( v ) { self.showOriginal = v; self.renderPreview(); },
         "<p>Toggle to compare with the RGB image alone.</p>" );
      this.cropCheck = CT.ui.check( this, "1:1 crop", false,
         function( v ) { self.setCropMode( v ); },
         "<p>Show a full-resolution crop instead of the whole image, to judge Detail and noise. " +
         "Click the preview to choose where (in either mode).</p>" );
      this.fitButton = CT.ui.button( this, "Fit", function() { self.preview.fit(); } );
      this.right = new VerticalSizer;
      this.right.spacing = 4;
      this.right.add( this.preview, 100 );
      this.right.add( CT.ui.row( [ this.previewButton, this.originalCheck, this.cropCheck, this.fitButton, "stretch" ] ) );

      this.sizer = new HorizontalSizer;
      this.sizer.margin = 8;
      this.sizer.spacing = 8;
      this.sizer.add( this.left );
      this.sizer.add( this.right, 100 );

      this.timer = new Timer;
      this.timer.interval = 0.15;
      this.timer.periodic = false;
      this.timer.onTimeout = function() { self.renderPreview(); };

      this.updateEnabled();
      this.adjustToContents();
      this.setScaledMinSize( 1150, 780 );
   }

   views()
   {
      let v = { target: this.targetList.currentView };
      for ( let L of NBADD.LINES )
         v[L.key] = this.lineUI[L.key].list.currentView;
      return v;
   }

   inputsChanged()
   {
      this.d = null;
      this.cropMode = false;
      this.cropCheck.checked = false;
      this.preview.clear( "Press 'Update preview'" );
      this.updateEnabled();
   }

   updateEnabled()
   {
      let v = this.views();
      let any = false;
      for ( let L of NBADD.LINES )
      {
         let has = CT.isView( v[L.key] );
         let ui = this.lineUI[L.key];
         ui.r.enabled = ui.g.enabled = ui.b.enabled = ui.strength.enabled = ui.black.enabled =
            ui.lum.enabled = ui.detail.enabled = has;
         ui.auto.enabled = has && !this.busy;
         any = any || has;
      }
      let ok = CT.isView( v.target ) && any;
      this.previewButton.enabled = ok && !this.busy;
      this.runButton.enabled = ok && !this.busy;
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
      let ids = [ CT.isView( v.target ) ? v.target.id : "" ];
      for ( let L of NBADD.LINES )
         ids.push( CT.isView( v[L.key] ) ? v[L.key].id : "" );
      if ( this.d && this.d.ids == ids.join( "|" ) )
         return this.d;
      this.setBusy( true, "Loading images..." );
      let views = {};
      for ( let L of NBADD.LINES ) views[L.key] = v[L.key];
      this.d = NBADD.load( v.target, views );
      return this.d;
   }

   resetLine( key )
   {
      let def = NBADD.defaults();
      let ui = this.lineUI[key];
      for ( let s of NBADD.LINE_PARAMS )
         this.p[key + "_" + s] = def[key + "_" + s];
      ui.r.setValue( def[key + "_r"] ); ui.g.setValue( def[key + "_g"] ); ui.b.setValue( def[key + "_b"] );
      ui.strength.setValue( def[key + "_strength"] ); ui.black.setValue( def[key + "_black"] );
      ui.lum.setValue( def[key + "_lum"] ); ui.detail.setValue( def[key + "_detail"] );
      this.schedulePreview();
   }

   doAutoBlack( key )
   {
      let self = this;
      this.guard( function()
      {
         let v = self.views()[key];
         if ( !CT.isView( v ) )
            return;
         self.setBusy( true, "Measuring the background..." );
         let g = CT.geometry( v );
         let b = NBADD.autoBlack( CT.getChannel( v, 0 ), g.W, g.H );
         self.p[key + "_black"] = b;
         self.lineUI[key].black.setValue( b );
         self.status.text = "Black point set to " + CT.fmt( b, 4 ) + ".";
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
         NBADD.previewSetup( d, 1600, 1100 );
         self.cropMode = false;
         self.cropCheck.checked = false;
         self.renderPreview( true );
         self.status.text = d.looksLinear ?
            "The RGB image looks linear. This blend is meant for stretched images (shown here with an AutoSTF)." :
            "Preview ready. Every control updates it live; toggle 'Show original' to compare.";
      } );
   }

   schedulePreview()
   {
      if ( this.d && this.d.preview && !this.busy )
      {
         this.timer.stop();
         this.timer.start();
      }
   }

   renderPreview( refit )
   {
      if ( !this.d || !this.d.preview )
         return;
      try
      {
         let crop = this.cropMode && !!this.d.crop;
         let bmp = NBADD.previewBitmap( this.d, this.p, this.showOriginal, crop );
         this.preview.setBitmap( bmp, crop ? 1 : this.d.preview.f, !refit );
      }
      catch ( e )
      {
         CT.warn( "Preview failed: " + e );
      }
   }

   // Image coordinates of a preview click choose the crop centre.
   clickPreview( x, y )
   {
      if ( !this.d || !this.d.preview || this.busy )
         return;
      if ( this.cropMode && this.d.crop )
      {
         x += this.d.crop.x0;
         y += this.d.crop.y0;
      }
      NBADD.cropSetup( this.d, x, y, 900, 650 );
      if ( !this.cropMode )
      {
         this.cropMode = true;
         this.cropCheck.checked = true;
      }
      this.status.text = format( "1:1 crop at %d, %d. Click again to move it; untick '1:1 crop' for the whole image.",
                                 Math.round( x ), Math.round( y ) );
      this.renderPreview( true );
   }

   setCropMode( on )
   {
      this.cropMode = on;
      if ( on && this.d && this.d.preview && !this.d.crop )
         NBADD.cropSetup( this.d, this.d.W / 2, this.d.H / 2, 900, 650 );
      this.renderPreview( true );
   }

   doRun()
   {
      let self = this;
      this.guard( function()
      {
         let v = self.views();
         let d = self.ensureData();
         self.setBusy( true, "Adding narrowband..." );
         let win = NBADD.execute( d, v.target, self.p );
         self.status.text = ( self.p.newImage ? "Created " : "Updated " ) + win.mainView.id + ".";
         if ( !self.p.newImage )
            self.d = null;   // the target changed: reload before the next run
      } );
   }

   cleanup()
   {
      this.timer.stop();
      let s = { m: this.p.m, newImage: this.p.newImage, detailRadius: this.p.detailRadius };
      for ( let L of NBADD.LINES )
         for ( let k of NBADD.LINE_PARAMS )
            s[L.key + "_" + k] = this.p[L.key + "_" + k];
      CT.saveSettings( NBADD.TOOL, s );
      this.d = null;
   }
};
