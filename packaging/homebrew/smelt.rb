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
  # ship inside the tarball; no native build, no postinstall download.
  depends_on "node"

  def install
    # The classic npm-tarball install, spelled out: no Homebrew helper methods, so
    # the formula works on any brew that can pour it. The tarball is the registry's
    # own, so deps resolve to exactly what npm install would fetch anywhere.
    # --global --prefix is the classic npm-tarball layout: the package and its one
    # runtime dependency land in libexec/lib/node_modules, and the bin link the
    # package declares lands in libexec/bin — which is what the symlink below pours.
    system "npm", "install", "--global", "--prefix", libexec.to_s, "--omit=dev",
           "--no-audit", "--no-fund", buildpath.to_s
    bin.install_symlink libexec/"bin/smelt"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/smelt --version")
  end
end
