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
import shutil
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


def make_cmd():
    """Rend la commande `make` a utiliser.

    STM32CubeIDE fournit son propre make, dans un plugin dont le nom porte un numero de
    version qui change d'une version de l'IDE a l'autre. Il n'est pas dans le PATH, et
    demander a l'utilisateur de l'y mettre serait une deuxieme configuration a tenir a jour
    en plus de `toolchain.local.mk` — donc une occasion de plus de les voir diverger.

    On repart de la meme source de verite : `IDE` dans `toolchain.local.mk` designe deja le
    dossier des plugins. On y cherche celui du make. A defaut, `make` tout court, qui marche
    sur un poste ou il est installe autrement.
    """
    plain = "make"
    if shutil.which("make"):
        return plain

    local = os.path.join(FW, "toolchain.local.mk")
    if not os.path.isfile(local):
        return plain
    with io.open(local, encoding="utf-8", errors="replace") as fh:
        m = re.search(r"^\s*IDE\s*:?=\s*(.+?)\s*$", fh.read(), re.M)
    if m is None:
        return plain

    plugins = m.group(1)
    if not os.path.isdir(plugins):
        return plain
    for name in sorted(os.listdir(plugins)):
        if "externaltools.make" not in name:
            continue
        exe = os.path.join(plugins, name, "tools", "bin", "make.exe")
        if os.path.isfile(exe):
            return '"%s"' % exe
    return plain


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


def block(text, var):
    """Rend les chemins listes par une variable du Makefile, continuations comprises."""
    out, collecting = [], False
    for line in text.splitlines():
        if not collecting:
            if line.startswith(var):
                collecting = True
            else:
                continue
        for m in SOURCE_REF.finditer(line):
            if m.group(1).startswith(OWNED_PREFIXES):
                out.append(m.group(1))
        if collecting and not line.rstrip().endswith("\\"):
            break
    return out


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

    # Distinguer ce qui bloque `make` de ce qui ne bloque que `make boot-images`. Une liste
    # plate ne dit pas si le firmware de bring-up se construit, et c'est la seule question
    # qui se pose au quotidien.
    app = set(block(text, "APP_C_SOURCES")) | {"ld/stm32g473ce_standalone.ld"}
    blocking = [r for r in missing if r in app]
    boot_only = [r for r in missing if r not in app]

    print("  %d ABSENT(S) :" % len(missing))
    for r in blocking:
        print("    manquant (bloque `make`) : " + r)
    for r in boot_only:
        print("    manquant (cibles bootloader seulement) : " + r)
    if not blocking:
        print("  l'image autonome a toutes ses sources ; `make` peut aboutir")


def hosttest():
    """Tests hors cible du firmware : la logique qui ne demande ni carte ni toolchain ARM."""
    section("Tests hors cible du firmware")
    runner = os.path.join(FW, "tools", "hosttest", "run.py")
    if not os.path.isfile(runner):
        print("  harnais absent")
        return
    code, out = run('"%s" "%s"' % (sys.executable, runner), ROOT)
    # Une ligne de total par suite. N'en lire qu'une sous-declarait la couverture d'un
    # facteur trois des qu'une deuxieme suite est apparue, ce qui est exactement le genre
    # de silence que cet outil est cense ne plus produire.
    tallies = re.findall(r"(\d+) verifications passees, (\d+) en echec", out)
    if tallies:
        ok = sum(int(a) for a, _ in tallies)
        ko = sum(int(b) for _, b in tallies)
        print("  %d verification(s) sur %d suite(s), %d en echec" % (ok, len(tallies), ko))
    elif "Aucun compilateur" in out:
        print("  aucun compilateur hote (gcc, clang ou cl) — suites non executees")
    else:
        print("  resultat illisible (code %s)" % code)
    for l in out.splitlines():
        if l.strip().startswith(("ECHEC", "avertissement", "compilation en echec")):
            print("    " + l.strip())


def boot_images():
    """Les trois images A/B. Le bootloader est le seul binaire du depot qui soit a l'etroit.

    Son slot fait 32 ko et rien ne l'agrandira : il precede le slot A, dont l'adresse est
    figee dans trois linkers et dans les metadonnees deja ecrites sur les cartes. Un
    depassement se voit au link, mais autant voir venir le mur avant de le toucher.
    """
    section("Images bootloader A/B")
    mk = make_cmd()
    rows = [("bootloader", "bootloader", 32 * 1024),
            ("slot A", "slot-a", 224 * 1024),
            ("slot B", "slot-b", 224 * 1024)]
    # Le Makefile nomme le binaire du bootloader autrement que son dossier.
    binaries = {"bootloader": "a2n-bldc-bootloader.bin",
                "slot-a": "a2n-bldc-slot-a.bin",
                "slot-b": "a2n-bldc-slot-b.bin"}
    for label, image, capacity in rows:
        code, out = run("%s IMAGE=%s" % (mk, image), FW)
        if code is None or MISSING_TOOL.search(out):
            print("  build impossible : `make` introuvable")
            return
        if code != 0:
            print("  %-10s ECHEC DE BUILD" % label)
            for l in out.splitlines():
                if "error" in l.lower():
                    print("    " + l.strip())
            continue
        warn = len([l for l in out.splitlines() if "warning" in l.lower()])
        # La taille se lit sur le .bin plutot que dans la sortie du link : c'est
        # exactement ce qui sera programme, et c'est disponible meme quand `make`
        # n'a rien eu a refaire — cas frequent, et ou la version precedente
        # n'affichait rien du tout.
        binary = os.path.join(FW, "build", image, binaries[image])
        if not os.path.isfile(binary):
            print("  %-10s binaire introuvable (%s)" % (label, binary))
            continue
        used = os.path.getsize(binary)
        print("  %-10s %6d o sur %6d  (%5.1f %%)%s"
              % (label, used, capacity, 100.0 * used / capacity,
                 "" if warn == 0 else "  %d avertissement(s)" % warn))


def firmware():
    section("Firmware")
    mk = make_cmd()
    code, out = run(mk, FW)
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
        code2, out2 = run(mk + " size", FW)
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
        "hosttest": hosttest, "fw": firmware, "boot": boot_images,
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
