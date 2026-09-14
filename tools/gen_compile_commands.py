#!/usr/bin/env python3
"""Genere compile_commands.json a partir du Makefile, pour clangd.

Le projet ne depend pas de CMake : cette base de compilation est reconstruite en
relisant les variables du Makefile plutot qu'en instrumentant le build.
"""
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def make_var(name):
    out = subprocess.run(
        ["make", "-s", "-C", ROOT, "print-" + name],
        capture_output=True, text=True,
    )
    return out.stdout.strip()


def main():
    # On demande a make de nous rendre les variables plutot que de reparser le fichier.
    mk = os.path.join(ROOT, "Makefile")
    if not os.path.exists(mk):
        sys.exit("Makefile introuvable")

    helper = os.path.join(ROOT, ".compdb.mk")
    with open(helper, "w", encoding="utf-8") as f:
        f.write("include Makefile\n")
        f.write("print-%:\n\t@echo $($*)\n")

    try:
        res = subprocess.run(
            ["make", "-s", "-f", ".compdb.mk", "-C", ROOT,
             "print-CC", "print-CFLAGS", "print-ALL_C"],
            capture_output=True, text=True,
        )
        lines = [l for l in res.stdout.splitlines() if l.strip()]
        if len(lines) < 3:
            sys.exit("make n'a pas rendu les variables attendues:\n" + res.stderr)
        cc, cflags, sources = lines[0], lines[1], lines[2].split()
    finally:
        os.remove(helper)

    # -MMD/-MP/-MF n'ont pas de sens pour clangd et perturbent l'indexation.
    cflags = re.sub(r'-MMD|-MP|-MF"[^"]*"', "", cflags).strip()

    db = [
        {
            "directory": ROOT,
            "command": f"{cc} {cflags} -c {src}",
            "file": os.path.normpath(os.path.join(ROOT, src)),
        }
        for src in sources
    ]

    dest = os.path.join(ROOT, "compile_commands.json")
    with open(dest, "w", encoding="utf-8") as f:
        json.dump(db, f, indent=2)
    print(f"{len(db)} entrees -> {dest}")


if __name__ == "__main__":
    main()
