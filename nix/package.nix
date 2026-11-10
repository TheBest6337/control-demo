{
  lib,
  buildNpmPackage,
  importNpmLock,
  makeWrapper,
  nodejs_24,
}:

let
  root = ../.;
  # keep local build outputs and editor junk out of the store path
  src = lib.cleanSourceWith {
    src = root;
    filter =
      path: type:
      let
        rel = lib.removePrefix (toString root + "/") (toString path);
      in
      !(lib.elem rel [
        "node_modules"
        "dist-server"
        "ui/dist"
        "result"
      ])
      && !(lib.hasPrefix "result-" rel)
      && lib.cleanSourceFilter path type;
  };
in
buildNpmPackage (finalAttrs: {
  pname = "qitech-control-demo";
  version = (lib.importJSON (root + "/package.json")).version;
  inherit src;

  nodejs = nodejs_24;
  npmFlags = [
    "--no-audit"
    "--no-fund"
  ];

  # hash-free: every lock entry carries resolved + integrity
  # (same approach as control/nixos/packages/electron.nix)
  npmDeps = importNpmLock { npmRoot = root; };
  npmConfigHook = importNpmLock.npmConfigHook;

  nativeBuildInputs = [ makeWrapper ];

  # `npm run build`: vite build of ui/ (with the in-browser simulation in
  # backend/) + tsc of the static file server in server/
  doCheck = true;
  checkPhase = ''
    runHook preCheck
    npm test
    runHook postCheck
  '';

  installPhase = ''
    runHook preInstall

    appdir=$out/share/qitech-control-demo
    mkdir -p $appdir/ui
    cp -r package.json dist-server $appdir/
    cp -r ui/dist $appdir/ui/dist

    makeWrapper ${nodejs_24}/bin/node $out/bin/qitech-control-demo \
      --add-flags $appdir/dist-server/main.js \
      --set-default DEMO_STATIC_DIR $appdir/ui/dist

    runHook postInstall
  '';

  meta = {
    description = "QiTech Control operator UI with simulated machines, for demos";
    platforms = lib.platforms.unix;
    mainProgram = "qitech-control-demo";
  };
})
