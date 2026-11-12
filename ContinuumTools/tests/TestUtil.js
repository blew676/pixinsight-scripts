// Shared helpers for the headless tests (development only).
// Arguments: jsArguments[0] = output directory for logs/results.

var T = {};
T.DATA = "G:/Edge8/Processing/sh2-155/master/";
T.OUT = ( typeof jsArguments != "undefined" && jsArguments.length > 0 ) ? jsArguments[0] : File.systemTempDirectory;
T.lines = [];
T.name = "test";

T.log = function( s )
{
   T.lines.push( String( s ) );
   console.writeln( s );
   try { File.writeTextFile( T.OUT + "/" + T.name + "_log.txt", T.lines.join( "\n" ) + "\n" ); } catch ( e ) {}
};

T.open = function( path )
{
   let w = ImageWindow.open( path );
   if ( !w || w.length == 0 )
      throw new Error( "cannot open " + path );
   return w[0].mainView;
};

// Raw float32 dump of a buffer (read back with node for inspection).
T.dump = function( name, a )
{
   let f = new File;
   f.createForWriting( T.OUT + "/" + name + ".f32" );
   f.write( a );
   f.close();
};

T.run = function( name, fn )
{
   T.name = name;
   let t0 = Date.now();
   try
   {
      fn();
      T.log( "PASS " + name + " in " + ( ( Date.now() - t0 ) / 1000 ).toFixed( 1 ) + " s" );
   }
   catch ( e )
   {
      T.log( "FAIL " + name + ": " + e + "\n" + ( e.stack || "" ) );
   }
   let ws = ImageWindow.windows;
   for ( let i = 0; i < ws.length; ++i )
      ws[i].forceClose();
};
