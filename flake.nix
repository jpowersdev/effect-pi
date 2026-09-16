{
  description = "effect-pi — Effect v4 on Node.js";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    { nixpkgs, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      devShells = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              git
              nodejs_26
              pnpm
              util-linux
            ];

            shellHook = ''
              project_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
              if [[ -x "$project_root/scripts/update-effect-vendor" ]]; then
                "$project_root/scripts/update-effect-vendor" || \
                  printf 'Warning: could not update .vendor/effect; continuing with the existing copy.\n' >&2
              fi
              unset project_root
            '';
          };
        }
      );

      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt);
    };
}
