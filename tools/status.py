#!/usr/bin/env python3
"""Releve l'etat reel du depot : tests, build, tailles, derniers commits.

    python tools/status.py

Pourquoi un script plutot qu'un tableau tenu a jour dans un fichier : les chiffres volatils
recopies a la main sont faux des le lendemain. Ce depot en a fait la demonstration — trois
valeurs differentes du nombre de tests coexistaient dans la documentation au bout de trois
passes de travail. STATUS.md porte donc l'etat des jalons, qui change lentement, et ce script
mesure le reste.

Il ne modifie rien et ne rend jamais un code d'erreur sur un test qui echoue : ce n'est pas un
outil de CI, c'est un constat.
"""
import io
import os
import re
import subprocess
import sys

# La console Windows est en cp1252 par defaut et leve sur la moindre coche. On reconfigure
# la sortie plutot que de renoncer aux symboles, qui rendent le constat lisible d'un coup.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
else:  # pragma: no cover - Python ancien
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IFACE = os.path.join(ROOT, "interface")
FW = os.path.join(ROOT, "controller-2")


ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")


def strip_ansi(text):
    return ANSI.sub("", text)


def run(cmd, cwd, timeout=600):
    """Lance une commande et rend (code, sortie). Un outil absent n'est pas une erreur."""
    try:
        p = subprocess.run(
            cmd, cwd=cwd, shell=True, capture_output=True, text=True,
            timeout=timeout, encoding="utf-8", errors="replace",
        )
        return p.returncode, strip_ansi((p.stdout or "") + (p.stderr or ""))
    except FileNotFoundError:
        return None, "outil introuvable"
    except subprocess.TimeoutExpired:
        return None, "delai depasse"


def section(title):
    print()
    print(title)
    print("-" * len(title))


def tests():
    section("Tests de l'interface")
    if not os.path.isdir(os.path.join(IFACE, "node_modules")):
        print("  node_modules absent — lancer `npm install` dans interface/")
        return
    code, out = run("npm test", IFACE)
    m = re.search(r"Tests\s+(\d+)\s+passed", out)
    f = re.search(r"(\d+)\s+failed", out)
    if m:
        print("  %s passes%s" % (m.group(1), ", %s en echec" % f.group(1) if f else ""))
    else:
        print("  resultat illisible (code %s)" % code)


def typecheck():
    section("Typage")
    if not os.path.isdir(os.path.join(IFACE, "node_modules")):
        print("  node_modules absent")
        return
    code, out = run("npx tsc --noEmit", IFACE)
    errors = [l for l in out.splitlines() if re.search(r"error TS\d+", l)]
    print("  %s" % ("strict, aucune erreur" if not errors else "%d erreur(s)" % len(errors)))
    for l in errors[:5]:
        print("    " + l.strip())


def firmware():
    section("Firmware")
    code, out = run("make", FW)
    if code is None or "toolchain absente" in out:
        print("  build impossible : toolchain introuvable")
        print("  (copier toolchain.local.mk.example en toolchain.local.mk)")
        return

    ram = re.search(r"RAM:\s+(\d+) B\s+(\S+)\s+([\d.]+)%", out)
    flash = re.search(r"FLASH:\s+(\d+) B\s+(\S+)\s+([\d.]+)%", out)
    if flash and ram:
        print("  flash %s o sur %s  (%s %%)" % (flash.group(1), flash.group(2), flash.group(3)))
        print("  ram   %s o sur %s  (%s %%)" % (ram.group(1), ram.group(2), ram.group(3)))
    else:
        # Rien n'a ete relie, donc pas de --print-memory-usage : on relit l'ELF avec
        # `size -A`, qui liste les sections avec leur adresse de chargement.
        code2, out2 = run("make size", FW)
        flash_b, ram_b = 0, 0
        for line in out2.splitlines():
            m = re.match(r"^\s*(\.\S+)\s+(\d+)\s+(\d+)\s*$", line)
            if not m:
                continue
            size, addr = int(m.group(2)), int(m.group(3))
            # On classe par adresse plutot que par nom de section : c'est le decoupage
            # du linker script qui fait foi, pas une liste de noms a tenir a jour.
            if 0x08000000 <= addr < 0x20000000:
                flash_b += size
            elif addr >= 0x20000000:
                ram_b += size
                # .data est initialisee depuis la flash : elle occupe les deux.
                if m.group(1) == ".data":
                    flash_b += size
        if flash_b > 0:
            # Quelques octets de moins que le total du linker : les sections
            # d'alignement ne portent pas d'adresse et ne sont pas comptees ici.
            # L'ecart est d'une dizaine d'octets, sans consequence pour un constat.
            print("  flash %d o sur 262144  (%.2f %%)" % (flash_b, 100.0 * flash_b / 262144))
            print("  ram   %d o sur 131072  (%.2f %%)" % (ram_b, 100.0 * ram_b / 131072))
        else:
            print("  build a jour, tailles illisibles")

    warnings = [l for l in out.splitlines() if "warning:" in l]
    print("  %d avertissement(s) de compilation" % len(warnings))


def simulator():
    section("Validation sur simulateur")
    if not os.path.isdir(os.path.join(IFACE, "node_modules")):
        print("  node_modules absent")
        return
    code, out = run("npm run cli -- check --sim", IFACE)
    lines = [l.rstrip() for l in out.splitlines() if l.strip().startswith(("✓", "✗"))]
    for l in lines:
        print("  " + l.strip())
    if not lines:
        print("  aucune sortie exploitable (code %s)" % code)


def board():
    section("Carte")
    if not os.path.isdir(os.path.join(IFACE, "node_modules")):
        print("  node_modules absent")
        return
    code, out = run("npm run cli -- ports", IFACE, timeout=60)
    if "A2N board" in out:
        print("  carte detectee — `npm run cli -- check` valide le jalon pour de vrai")
    else:
        print("  aucune carte A2N branchee")


def history():
    section("Derniers commits")
    code, out = run("git log --oneline -5", ROOT, timeout=30)
    for l in out.splitlines()[:5]:
        print("  " + l)
    code, out = run("git status --porcelain", ROOT, timeout=30)
    dirty = [l for l in out.splitlines() if l.strip()]
    print("  arbre %s" % ("propre" if not dirty else "modifie : %d fichier(s)" % len(dirty)))


def main():
    print("Etat du depot A2N BLDC")
    print("=" * 22)
    print("Les jalons sont dans STATUS.md ; ci-dessous, ce qui se mesure.")

    only = sys.argv[1] if len(sys.argv) > 1 else None
    steps = {
        "tests": tests, "types": typecheck, "fw": firmware,
        "sim": simulator, "board": board, "git": history,
    }
    if only in steps:
        steps[only]()
    else:
        for fn in steps.values():
            fn()
    print()


if __name__ == "__main__":
    main()
