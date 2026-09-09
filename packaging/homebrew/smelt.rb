# The smelt formula, as the tap carries it. This file is RENDERED — never edit the
# version or the hash by hand; run `node scripts/render-formula.mjs <version> <sha256>`
# with the release the workflow published. The sha256 is of the exact registry
# tarball bytes, because a formula that hashes anything else vouches for bytes nobody
# served.
class Smelt < Formula
  desc "Structure-aware, reversible context optimization for AI coding agents"
  homepage "https://github.com/smeltjs/smelt"
  url "https://registry.npmjs.org/@smeltjs/core/-/core-0.5.0.tgz"
  sha256 "7f837356077bc08373e89a121d6ad6a74f63433a4d9fd645dd8f13cb5f851549"
  license "Apache-2.0"

  # smelt is a Node CLI — one runtime dependency, web-tree-sitter, whose grammars
  # ship inside the tarball; no native build, no postinstall download. node is
  # :recommended, not required: `--without-node` builds against whatever node is
  # already on PATH, which must clear the engines floor in packages/core/package.json
  # (^20.19.0 || >=22.12.0) — and, because Homebrew builds run under superenv, which
  # resets PATH to the Homebrew prefix bin plus the standard system directories, that
  # node must live somewhere superenv keeps (e.g. /usr/local/bin or the Homebrew
  # prefix), not just on a shell profile's PATH — a version-manager shim (nvm, volta,
  # fnm) is invisible to the build. install below never references Formula["node"]
  # directly — plain "npm" resolves to Homebrew's node when it is installed, and to
  # PATH's node otherwise, so both builds share the one code path.
  depends_on "node" => :recommended

  def install
    # The classic npm-tarball install, spelled out: no Homebrew helper methods, so
    # the formula works on any brew that can pour it. The tarball is the registry's
    # own, so deps resolve to exactly what npm install would fetch anywhere.
    # npm -g over a directory installs a symlink to it (gone when brew cleans the
    # buildpath); over a tarball it installs the bytes. Pack the prebuilt tree to a
    # tgz — scripts ignored, the registry tarball was built by CI's prepack — then
    # install that into libexec's global layout: the package and its one runtime
    # dependency land in lib/lib/node_modules, and libexec/bin/smelt is the bin link
    # the symlink below pours.
    system "npm", "pack", "--ignore-scripts"
    system "npm", "install", "--global", "--prefix", libexec.to_s, "--omit=dev",
           "--no-audit", "--no-fund", "--ignore-scripts", Dir["*.tgz"].first
    bin.install_symlink libexec/"bin/smelt"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/smelt --version")
  end
end
