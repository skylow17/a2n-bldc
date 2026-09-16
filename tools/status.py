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
    """Lance une commande et rend (code, sortie).

    `code` vaut None quand la commande n'a pas pu etre lancee du tout. Le shell renvoie
    sinon son propre code, y compris pour un exécutable introuvable : c'est a l'appelant
    de le regarder. Ne pas le faire est precisement le defaut que ce fichier a porte —
    `make` absent du PATH etait rapporte comme un firmware en bon etat.
    """
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


# Un outil absent du PATH ne se signale pas de la meme facon selon le shell.
MISSING_TOOL = re.compile(
    r"command not found|n'est pas reconnu|is not recognized|CommandNotFound", re.I
)


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


# Racines des sources qui appartiennent au depot. Le reste des chemins du Makefile
# pointe vers le paquet HAL/CubeMX, installe par poste et donc hors de notre controle.
OWNED_PREFIXES = ("Core/", "Boot/", "USB_Device/", "startup/", "ld/")
SOURCE_REF = re.compile(r"(?<![\w./$(-])((?:[\w.-]+/)+[\w.-]+\.(?:c|s|ld))")


def sources():
    """Verifie que tout fichier du depot cite par le Makefile existe reellement.

    Ce controle ne demande aucune toolchain, et c'est la raison d'etre de son existence :
    le defaut est arrive deux fois sur ce depot — un fichier reference par le Makefile,
    jamais commite, donc un clone frais qui ne compile pas. Un poste sans CubeIDE ne peut
    pas s'en apercevoir en lancant `make`, mais il peut le lire ici.
    """
    section("Sources du firmware")
    makefile = os.path.join(FW, "Makefile")
    if not os.path.isfile(makefile):
        print("  Makefile introuvable")
        return
    with io.open(makefile, encoding="utf-8", errors="replace") as fh:
        text = fh.read()

    refs = []
    for m in SOURCE_REF.finditer(text):
        rel = m.group(1)
        if rel.startswith(OWNED_PREFIXES) and rel not in refs:
            refs.append(rel)

    missing = [r for r in refs if not os.path.isfile(os.path.join(FW, r))]
    print("  %d fichier(s) cite(s) par le Makefile" % len(refs))
    if not missing:
        print("  tous presents")
        return
    print("  %d ABSENT(S) — le firmware ne peut pas etre construit :" % len(missing))
    for r in missing:
        print("    manquant : " + r)


def hosttest():
    """Tests hors cible du firmware : la logique qui ne demande ni carte ni toolchain ARM."""
    section("Tests hors cible du firmware")
    runner = os.path.join(FW, "tools", "hosttest", "run.py")
    if not os.path.isfile(runner):
        print("  harnais absent")
        return
    code, out = run('"%s" "%s"' % (sys.executable, runner), ROOT)
    lines = [l.strip() for l in out.splitlines() if "verifications passees" in l]
    if lines:
        print("  " + lines[0])
    elif "Aucun compilateur" in out:
        print("  aucun compilateur hote (gcc, clang ou cl) — suites non executees")
    else:
        print("  resultat illisible (code %s)" % code)
    for l in out.splitlines():
        if l.strip().startswith(("ECHEC", "avertissement", "compilation en echec")):
            print("    " + l.strip())


def firmware():
    section("Firmware")
    code, out = run("make", FW)
    if code is None or MISSING_TOOL.search(out):
        print("  build impossible : `make` introuvable")
        print("  (il est fourni par STM32CubeIDE ; voir README.md)")
        return
    if "toolchain absente" in out:
        print("  build impossible : toolchain introuvable")
        print("  (copier toolchain.local.mk.example en toolchain.local.mk)")
        return
    if code != 0:
        # Un build casse doit se voir ici. La version precedente de cette fonction
        # retombait sur « build a jour, tailles illisibles » et annoncait
        # 0 avertissement, ce qui faisait passer un firmware qui ne compilait pas
        # pour un firmware sain.
        print("  BUILD EN ECHEC (code %s)" % code)
        for l in [l for l in out.splitlines() if "error" in l.lower()][:5]:
            print("    " + l.strip())
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
            # Le build a reussi (code 0 verifie plus haut) mais rien n'a ete relie :
            # `make` n'avait rien a refaire et l'ELF n'est pas lisible d'ici.
            print("  build a jour ; tailles indisponibles (`make clean && make` pour les relever)")

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
        "tests": tests, "types": typecheck, "sources": sources,
        "hosttest": hosttest, "fw": firmware,
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
