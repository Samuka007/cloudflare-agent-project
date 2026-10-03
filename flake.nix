{
  "description": "Dev shell for cloudflare-agent-project (M0 walking skeleton).",
  "inputs": {
    "nixpkgs": { "url": "github:NixOS/nixpkgs/nixos-25.05" }
  },
  "outputs": { self, nixpkgs, ... }:
  let
    system = "x86_64-linux";
    pkgs = nixpkgs.legacyPackages.${system};
  in
  {
    devShells.${system}.default = pkgs.mkShell {
      packages = with pkgs; [
        nodejs_22
        pnpm_10
      ];
    };
  };
}
