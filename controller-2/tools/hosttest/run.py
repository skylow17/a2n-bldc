#!/usr/bin/env python3
"""Compile et execute les tests hors cible du firmware.

    python controller-2/tools/hosttest/run.py

Pourquoi des tests hors cible dans un projet bare-metal : une partie de la logique du
firmware ne touche pas au materiel — serialisation du dictionnaire de signaux, validation
d'une configuration de scope, arithmetique de l'anneau de capture, decimation,
declenchement. Cette partie se verifie sur un PC, en quelques secondes, sans carte et sans
toolchain ARM. C'est ce qui reste faisable quand le materiel n'est pas la.

Ce que ces tests **ne** prouvent **pas** : rien de ce qui touche a l'ADC, a TIM1, a l'USB,
aux temps d'execution ou au comportement reel des interruptions. Les modules testes sont
compiles avec un bouchon de `board.h` et un masquage d'interruption simule. Un jalon reste
« passe » uniquement quand `npm run cli -- check` est vert sur la vraie carte — voir
STATUS.md.

N'importe quel compilateur C de l'hote fait l'affaire : cl (Visual Studio), gcc ou clang.
Le script prend le premier qu'il trouve.
"""
import io
import os
import shutil
import subprocess
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
else:  # pragma: no cover - Python ancien
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
FW = os.path.dirname(os.path.dirname(HERE))

# Modules testables hors cible, et le test qui les exerce. Ajouter une ligne ici quand un
# module devient testable sans materiel.
SUITES = [
    ("M1c — signaux et scope", "test_m1c.c", [
        "Core/Src/comm/signals.c",
        "Core/Src/comm/scope.c",
    ], []),
    # boot_shared.c se compile ici sans HAL ni zone SRAM partagee : le define ne laisse que
    # la fonction de decision, qui est la seule partie qui tranche quoi que ce soit.
    # boot_flash.c est coupe en deux par BOOT_FLASH_HOSTTEST : la moitie materielle demande
    # le HAL, la moitie qui decide ne demande rien. C'est celle-ci qui peut briquer une carte.
    ("Bootloader — metadonnees A/B et validation", "test_boot_flash.c", [
        "Boot/Src/boot_flash.c",
    ], ["BOOT_FLASH_HOSTTEST"]),
    ("Bootloader — decision de probation", "test_boot_shared.c", [
        "Core/Src/boot_shared.c",
    ], ["BOOT_SHARED_HOSTTEST"]),
]

INCLUDES = [os.path.join(HERE, "shim"), os.path.join(FW, "Core", "Inc"),
            os.path.join(FW, "Boot", "Inc")]


def find_compiler():
    """Rend (nom, argv_prefix) du premier compilateur utilisable, ou (None, None)."""
    for name in ("gcc", "clang", "cc"):
        path = shutil.which(name)
        if path:
            return name, [path]
    if shutil.which("cl"):
        return "cl", ["cl"]
    # Visual Studio installe mais pas dans le PATH : passer par vcvars64.bat.
    for edition in ("Community", "Professional", "Enterprise", "BuildTools"):
        vc = ("C:/Program Files/Microsoft Visual Studio/2022/%s"
              "/VC/Auxiliary/Build/vcvars64.bat" % edition)
        if os.path.isfile(vc):
            # Chaine, pas liste : vcvars doit s'executer dans le meme shell que cl.
            return "cl", '"%s" >nul 2>nul && cl' % vc
    return None, None


def build_and_run(name, test_src, modules, defines, compiler, prefix, outdir):
    exe = os.path.join(outdir, os.path.splitext(test_src)[0] + (".exe" if os.name == "nt" else ""))
    sources = [os.path.join(HERE, test_src)] + [os.path.join(FW, m) for m in modules]

    if compiler == "cl":
        args = ["/nologo", "/W4", "/std:c11"]
        args += ["/D" + d for d in defines]
        args += ["/I" + i for i in INCLUDES]
        args += ["/Fe:" + exe, "/Fo:" + outdir + os.sep]
        args += sources
    else:
        args = ["-std=c11", "-Wall", "-Wextra", "-Wshadow", "-Wundef",
                "-Wdouble-promotion", "-Wno-unused-parameter", "-O1", "-g"]
        args += ["-D" + d for d in defines]
        args += ["-I" + i for i in INCLUDES]
        args += sources + ["-o", exe, "-lm"]

    print("== %s ==" % name)
    if isinstance(prefix, str):
        # Une barre oblique inverse juste avant le guillemet fermant echapperait ce
        # guillemet : cl recevrait alors un seul argument colle et se plaindrait de ne
        # pas avoir de fichier source. On la double.
        def q(a):
            return '"%s"' % (a + "\\" if a.endswith("\\") else a)
        cmd = prefix + " " + " ".join(q(a) for a in args)
        p = subprocess.run(cmd, shell=True, capture_output=True, text=True,
                           encoding="utf-8", errors="replace")
    else:
        p = subprocess.run(prefix + args, capture_output=True, text=True,
                           encoding="utf-8", errors="replace")

    out = (p.stdout or "") + (p.stderr or "")
    warnings = [l for l in out.splitlines()
                if ("warning" in l.lower()) and ("vcvars" not in l.lower())]
    if p.returncode != 0:
        print("  compilation en echec :")
        print("\n".join("    " + l for l in out.splitlines()[:20]))
        return 1
    for l in warnings:
        print("  avertissement : " + l.strip())

    r = subprocess.run([exe], capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    print("\n".join("  " + l for l in (r.stdout or "").splitlines() if l.strip()))
    if r.stderr:
        print("\n".join("  " + l for l in r.stderr.splitlines()))
    # Un avertissement de compilation compte comme un echec : la regle du depot est un
    # build muet, et elle vaut ici comme pour la cible.
    return 1 if (r.returncode != 0 or warnings) else 0


def main():
    compiler, prefix = find_compiler()
    if compiler is None:
        print("Aucun compilateur C de l'hote trouve (gcc, clang ou cl).")
        print("Ces tests sont un complement, pas une dependance de build : le firmware")
        print("se construit sans eux. Voir controller-2/AGENTS.md.")
        return 0

    outdir = os.path.join(HERE, "build")
    if not os.path.isdir(outdir):
        os.makedirs(outdir)

    print("Tests hors cible du firmware (compilateur : %s)\n" % compiler)
    failed = 0
    for name, test_src, modules, defines in SUITES:
        failed += build_and_run(name, test_src, modules, defines, compiler, prefix, outdir)
        print()

    if failed:
        print("%d suite(s) en echec" % failed)
    else:
        print("Toutes les suites passent.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
