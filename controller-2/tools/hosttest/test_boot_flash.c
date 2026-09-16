/* Harnais hote pour les metadonnees A/B et les regles de validation du bootloader.
 *
 * C'est le module qui peut briquer une carte. Une generation comparee a l'envers, un
 * candidat promu sans CRC, une ecriture acceptee hors du slot : aucune de ces erreurs ne se
 * voit a la relecture, et toutes se paient par un retour SWD sur une carte montee.
 *
 * Compile avec BOOT_FLASH_HOSTTEST : la moitie materielle du module est coupee, il ne reste
 * que la logique — c'est justement elle qui decide. */
#include <stdio.h>
#include <string.h>

#include "boot_flash.h"
#include "comm/proto.h"

static int s_pass = 0, s_fail = 0;

static void check(int cond, const char *what)
{
  if (cond) { s_pass++; }
  else { s_fail++; printf("  ECHEC : %s\n", what); }
}

/* ------------------------------------------------------------------ fixtures */

/* Un vecteur Cortex-M plausible pour le slot demande. */
static uint32_t ResetPc(uint32_t slot_addr) { return slot_addr + 0x200U + 1U; }

static void SessionErased(BootSession_t *s, uint8_t slot, uint32_t written)
{
  s->erased[slot] = true;
  s->written_max[slot] = written;
}

/* ------------------------------------------------------------------ CRC */

static void TestCrc(void)
{
  printf("CRC-32/ISO-HDLC\n");

  /* Le vecteur d'arbitrage de la specification. S'il tombe, le bootloader et l'hote ne
   * parlent pas du meme CRC, et chaque BOOT_VERIFY echouerait sans explication. */
  check(BootFlash_Crc32("123456789", 9U) == 0xCBF43926U,
        "CRC32(\"123456789\") == 0xCBF43926");
  check(BootFlash_Crc32("", 0U) == 0U, "CRC d'une suite vide == 0");

  const uint8_t a[4] = {0xDE, 0xAD, 0xBE, 0xEF};
  uint8_t b[4] = {0xDE, 0xAD, 0xBE, 0xEF};
  check(BootFlash_Crc32(a, 4U) == BootFlash_Crc32(b, 4U), "deterministe");
  b[3] ^= 0x01U;
  check(BootFlash_Crc32(a, 4U) != BootFlash_Crc32(b, 4U), "un bit change change le CRC");
}

/* ------------------------------------------------------------------ geometrie */

static void TestGeometry(void)
{
  printf("\ngeometrie flash\n");

  check(BootFlash_SlotAddr(BOOT_SLOT_A) == 0x08008000UL, "slot A a 0x08008000");
  check(BootFlash_SlotAddr(BOOT_SLOT_B) == 0x08040000UL, "slot B a 0x08040000");
  check(BootFlash_SlotAddr(BOOT_SLOT_NONE) == 0U, "aucun slot -> adresse nulle");
  check(BootFlash_SlotAddr(7U) == 0U, "un identifiant inconnu -> adresse nulle");

  /* Le slot A tient entierement en banque 1 et le slot B en banque 2 : c'est ce qui permet
   * d'ecrire l'un en s'executant depuis l'autre sans stall de lecture. */
  check((BOOT_SLOT_A_ADDR + BOOT_SLOT_CAPACITY) <= (FLASH_BASE_ADDR + FLASH_TOTAL_SIZE / 2U),
        "le slot A ne deborde pas de la banque 1");
  check(BOOT_SLOT_B_ADDR >= (FLASH_BASE_ADDR + FLASH_TOTAL_SIZE / 2U),
        "le slot B commence en banque 2");
  check((BOOT_META_ADDR + BOOT_META_SIZE) == (FLASH_BASE_ADDR + FLASH_TOTAL_SIZE),
        "les metadonnees ferment exactement les 512 ko");
  check((BOOT_SLOT_CAPACITY % FLASH_PAGE_SIZE) == 0U, "un slot est un nombre entier de pages");
  check(BOOT_META_PAGE_B == (BOOT_META_PAGE_A + FLASH_PAGE_SIZE),
        "les deux enregistrements sont sur deux pages distinctes");
  check((BOOT_META_RECORD_LEN % 8U) == 0U,
        "l'enregistrement est un multiple de 8 : le G4 ne programme qu'en double-mots");
}

/* ------------------------------------------------------------------ vecteurs */

static void TestVectors(void)
{
  printf("\nplausibilite des vecteurs\n");

  const uint32_t a = BOOT_SLOT_A_ADDR;
  check(BootFlash_VectorsPlausible(0x20020000UL, ResetPc(a), a),
        "pile en haut de SRAM, entree dans le slot, bit Thumb pose");
  check(BootFlash_VectorsPlausible(0x2001FF00UL, a + 1U, a),
        "une entree au tout debut du slot est acceptee");

  /* Une flash vierge, c'est 0xffffffff partout. C'est le cas qu'il faut ecarter en premier :
   * sauter dessus produit un HardFault muet au lieu d'un refus lisible. */
  check(!BootFlash_VectorsPlausible(0xFFFFFFFFUL, 0xFFFFFFFFUL, a),
        "refuse une flash vierge");
  check(!BootFlash_VectorsPlausible(0U, 0U, a), "refuse une flash a zero");

  check(!BootFlash_VectorsPlausible(0x08008000UL, ResetPc(a), a),
        "refuse un pointeur de pile en flash");
  check(!BootFlash_VectorsPlausible(0x20020008UL, ResetPc(a), a),
        "refuse un pointeur de pile au-dela de la SRAM");
  check(!BootFlash_VectorsPlausible(0x20020004UL, ResetPc(a), a),
        "refuse une pile mal alignee");

  /* Un vecteur de reset pair provoque une UsageFault des la premiere instruction, et c'est
   * la panne la plus opaque qu'un bootloader puisse produire. */
  check(!BootFlash_VectorsPlausible(0x20020000UL, a + 0x200U, a),
        "refuse un vecteur de reset sans bit Thumb");

  /* Une image batie pour le slot A et ecrite dans le slot B : le CRC serait juste, et elle
   * sauterait dans le vide. C'est exactement l'erreur que ce controle attrape. */
  check(!BootFlash_VectorsPlausible(0x20020000UL, ResetPc(BOOT_SLOT_A_ADDR), BOOT_SLOT_B_ADDR),
        "refuse une image batie pour l'autre slot");
  check(!BootFlash_VectorsPlausible(0x20020000UL, a + BOOT_SLOT_CAPACITY + 1U, a),
        "refuse une entree juste apres la fin du slot");
}

/* ------------------------------------------------------------------ enregistrement */

static void TestRecord(void)
{
  printf("\nenregistrement de metadonnees\n");

  BootMeta_t m;
  BootMeta_Blank(&m);
  m.slot[BOOT_SLOT_B].image_size = 4096U;
  m.slot[BOOT_SLOT_B].crc32 = 0x12345678U;
  m.slot[BOOT_SLOT_B].valid = 1U;
  memcpy(m.slot[BOOT_SLOT_B].version, "2.0.4", 6U);
  m.candidate_slot = BOOT_SLOT_B;

  uint8_t raw[BOOT_META_RECORD_LEN];
  BootMeta_Encode(&m, raw);

  BootMeta_t back;
  check(BootMeta_Decode(raw, &back), "un enregistrement se relit");
  check(back.generation == m.generation, "generation conservee");
  check(back.active_slot == BOOT_SLOT_A, "slot actif conserve");
  check(back.candidate_slot == BOOT_SLOT_B, "candidat conserve");
  check(back.slot[BOOT_SLOT_B].image_size == 4096U, "taille d'image conservee");
  check(back.slot[BOOT_SLOT_B].crc32 == 0x12345678U, "CRC d'image conserve");
  check(memcmp(back.slot[BOOT_SLOT_B].version, "2.0.4", 6U) == 0, "version conservee");

  /* Chaque octet compte : une page a moitie programmee au moment d'une coupure doit etre
   * rejetee, pas interpretee. */
  int caught = 1;
  for (size_t i = 0U; i < sizeof(raw); i++) {
    uint8_t save = raw[i];
    raw[i] ^= 0x01U;
    BootMeta_t junk;
    if (BootMeta_Decode(raw, &junk)) { caught = 0; }
    raw[i] = save;
  }
  check(caught, "un seul bit retourne, n'importe ou, invalide l'enregistrement");

  uint8_t blank[BOOT_META_RECORD_LEN];
  memset(blank, 0xFF, sizeof(blank));
  BootMeta_t junk;
  check(!BootMeta_Decode(blank, &junk), "une page vierge n'est pas un enregistrement");
  memset(blank, 0x00, sizeof(blank));
  check(!BootMeta_Decode(blank, &junk), "une page a zero non plus");

  /* Un CRC juste ne suffit pas : le contenu doit rester dans la geometrie. Un enregistrement
   * coherent avec lui-meme mais pas avec la carte enverrait le bootloader lire hors slot. */
  BootMeta_t wrong;
  BootMeta_Blank(&wrong);
  wrong.slot[BOOT_SLOT_A].image_size = BOOT_SLOT_CAPACITY + 8U;
  BootMeta_Encode(&wrong, raw);
  check(!BootMeta_Decode(raw, &junk), "refuse une image plus grande que son slot");

  BootMeta_Blank(&wrong);
  wrong.active_slot = 5U;
  BootMeta_Encode(&wrong, raw);
  check(!BootMeta_Decode(raw, &junk), "refuse un slot actif inexistant");
}

/* ------------------------------------------------------------------ choix de page */

static void TestPick(void)
{
  printf("\nchoix entre les deux pages\n");

  BootMeta_t a, b, out;
  bool from_a = false;
  BootMeta_Blank(&a);
  BootMeta_Blank(&b);

  a.generation = 7U;
  b.generation = 8U;
  check(BootMeta_Pick(&a, true, &b, true, &out, &from_a) && (out.generation == 8U) && !from_a,
        "la generation la plus haute gagne");

  a.generation = 9U;
  check(BootMeta_Pick(&a, true, &b, true, &out, &from_a) && (out.generation == 9U) && from_a,
        "et dans l'autre sens aussi");

  /* Une coupure pendant l'ecriture laisse toujours au moins une page lisible : c'est la
   * seule garantie que l'alternance apporte, et elle doit tenir. */
  check(BootMeta_Pick(&a, true, &b, false, &out, &from_a) && (out.generation == 9U) && from_a,
        "une seule page lisible : c'est elle");
  check(BootMeta_Pick(&a, false, &b, true, &out, &from_a) && (out.generation == 8U) && !from_a,
        "l'autre cote pareil");
  check(!BootMeta_Pick(&a, false, &b, false, &out, &from_a),
        "aucune page lisible : l'appelant repart d'un etat vierge");

  /* Rebouclage du compteur. Une comparaison naive dirait que 0 est plus ancien que
   * 0xffffffff et rendrait la carte au slot precedent a chaque mise a jour. */
  a.generation = 0xFFFFFFFEU;
  b.generation = 0x00000001U;
  check(BootMeta_Pick(&a, true, &b, true, &out, &from_a) && (out.generation == 1U) && !from_a,
        "le rebouclage du compteur de generation est gere");

  BootMeta_t blank;
  BootMeta_Blank(&blank);
  check(blank.active_slot == BOOT_SLOT_A, "flash sans metadonnees : slot A actif par defaut");
  check(blank.slot[0].valid == 0U && blank.slot[1].valid == 0U,
        "mais aucun slot n'est declare valide sans CRC verifie");
  check(blank.candidate_slot == BOOT_SLOT_NONE, "et aucun candidat en attente");
}

/* ------------------------------------------------------------------ effacement */

static void TestErase(void)
{
  printf("\nregles d'effacement\n");

  BootMeta_t m;
  BootMeta_Blank(&m);  /* A actif */

  /* Effacer le slot actif rendrait la carte non demarrable des que le candidat echouerait :
   * le rollback n'aurait plus ou retomber. */
  check(BootFlash_CheckErase(&m, BOOT_SLOT_A) == PROTO_ERR_STATE,
        "refuse d'effacer le slot actif");
  check(BootFlash_CheckErase(&m, BOOT_SLOT_B) == 0U, "accepte le slot inactif");
  check(BootFlash_CheckErase(&m, BOOT_SLOT_NONE) == PROTO_ERR_STATE, "refuse un slot inexistant");
  check(BootFlash_CheckErase(&m, 42U) == PROTO_ERR_STATE, "refuse un identifiant aberrant");

  m.active_slot = BOOT_SLOT_B;
  check(BootFlash_CheckErase(&m, BOOT_SLOT_B) == PROTO_ERR_STATE,
        "la regle suit le slot actif, elle ne vise pas B en particulier");
  check(BootFlash_CheckErase(&m, BOOT_SLOT_A) == 0U, "A devient effacable quand B est actif");
}

/* ------------------------------------------------------------------ ecriture */

static void TestWrite(void)
{
  printf("\nregles d'ecriture\n");

  BootMeta_t m;
  BootMeta_Blank(&m);  /* A actif */
  BootSession_t s;
  memset(&s, 0, sizeof(s));

  BootWriteReq_t r = { BOOT_SLOT_B, 8U, 0U };

  /* Sans effacement prealable, la flash ne saurait que passer des 1 a 0 : l'ecriture
   * « reussirait » en produisant une image fausse, dont le CRC ne serait decouvert qu'au
   * BOOT_VERIFY — ou jamais, si l'hote ne verifie pas. */
  check(BootFlash_CheckWrite(&m, &s, &r) == PROTO_ERR_STATE,
        "refuse une ecriture sans effacement dans la session courante");

  SessionErased(&s, BOOT_SLOT_B, 0U);
  check(BootFlash_CheckWrite(&m, &s, &r) == 0U, "accepte apres effacement");

  r.slot = BOOT_SLOT_A;
  check(BootFlash_CheckWrite(&m, &s, &r) == PROTO_ERR_STATE,
        "refuse d'ecrire dans le slot actif");
  r.slot = BOOT_SLOT_B;

  r.data_len = 0U;
  check(BootFlash_CheckWrite(&m, &s, &r) == PROTO_ERR_LEN, "refuse une longueur nulle");
  r.data_len = 4U;
  check(BootFlash_CheckWrite(&m, &s, &r) == PROTO_ERR_LEN, "refuse sous le minimum de 8");
  r.data_len = 12U;
  check(BootFlash_CheckWrite(&m, &s, &r) == PROTO_ERR_LEN,
        "refuse une longueur non multiple de 8");
  r.data_len = 512U;
  check(BootFlash_CheckWrite(&m, &s, &r) == PROTO_ERR_LEN,
        "refuse au-dela des 504 octets qui tiennent dans un payload");
  r.data_len = 504U;
  check(BootFlash_CheckWrite(&m, &s, &r) == 0U, "accepte exactement 504");

  r.data_len = 8U;
  r.offset = 4U;
  check(BootFlash_CheckWrite(&m, &s, &r) == PROTO_ERR_LEN, "refuse un offset mal aligne");

  r.offset = BOOT_SLOT_CAPACITY - 8U;
  check(BootFlash_CheckWrite(&m, &s, &r) == 0U, "accepte le tout dernier double-mot du slot");
  r.offset = BOOT_SLOT_CAPACITY;
  check(BootFlash_CheckWrite(&m, &s, &r) == PROTO_ERR_STATE, "refuse juste apres la fin");

  /* Debordement : offset + data_len calcule en 32 bits reboucle et le controle de bornes
   * laisserait passer une ecriture qui se traduirait par une adresse absolue quelconque. */
  r.offset = 0xFFFFFFF8UL;
  check(BootFlash_CheckWrite(&m, &s, &r) == PROTO_ERR_STATE,
        "refuse un offset qui ferait deborder la somme");

  /* Les codes suivent ceux du simulateur, que le client PC connait deja : ERR_LEN pour une
   * demande mal formee, ERR_STATE pour ce que l'etat de la carte refuse. Une divergence ici
   * donnerait un boot-check vert sur simulateur et rouge sur carte. */
  r.offset = 0U;
  r.slot = 9U;
  check(BootFlash_CheckWrite(&m, &s, &r) == PROTO_ERR_STATE,
        "un slot inexistant est refuse comme un etat, pas comme un argument");
}

/* ------------------------------------------------------------------ verification */

static void TestVerify(void)
{
  printf("\nregles de verification\n");

  BootMeta_t m;
  BootMeta_Blank(&m);
  BootSession_t s;
  memset(&s, 0, sizeof(s));

  BootVerifyReq_t v = { BOOT_SLOT_B, 4096U, 0xABCDEF01U };
  check(BootFlash_CheckVerify(&m, &s, &v) == PROTO_ERR_STATE,
        "refuse sans effacement dans la session");

  SessionErased(&s, BOOT_SLOT_B, 4096U);
  check(BootFlash_CheckVerify(&m, &s, &v) == 0U, "accepte ce qui a ete ecrit");

  /* Verifier au-dela de ce qui a ete ecrit relirait de la flash vierge : le CRC serait faux
   * et personne ne saurait dire si c'est l'image ou la demande qui est en cause. */
  v.image_size = 4104U;
  check(BootFlash_CheckVerify(&m, &s, &v) == PROTO_ERR_STATE,
        "refuse une taille superieure a ce qui a ete ecrit");

  v.image_size = 0U;
  check(BootFlash_CheckVerify(&m, &s, &v) == PROTO_ERR_STATE,
        "refuse une image vide");
  v.image_size = BOOT_SLOT_CAPACITY + 8U;
  check(BootFlash_CheckVerify(&m, &s, &v) == PROTO_ERR_STATE,
        "refuse une image plus grande que le slot");

  v.image_size = 4096U;
  v.slot = BOOT_SLOT_A;
  check(BootFlash_CheckVerify(&m, &s, &v) == PROTO_ERR_STATE, "refuse le slot actif");
}

/* ------------------------------------------------------------------ sequence A/B */

static void TestSequence(void)
{
  printf("\nsequence candidat / probation / rollback\n");

  BootMeta_t m;
  BootMeta_Blank(&m);
  bool trial = false, changed = false;

  /* Etat de depart : pas de candidat, on demarre le slot actif sans probation. */
  check(BootFlash_SelectBoot(&m, &trial, &changed) == BOOT_SLOT_A, "demarre le slot actif");
  check(!trial, "sans probation");
  check(!changed, "et sans reecrire les metadonnees");

  BootMeta_SetCandidate(&m, BOOT_SLOT_B, 4096U, 0xAAAA5555U, "2.1.0");
  check(m.candidate_slot == BOOT_SLOT_B, "BOOT_VERIFY designe le candidat");
  check(m.candidate_attempted == 0U, "candidat non essaye");
  check(m.active_slot == BOOT_SLOT_A, "le slot actif ne bouge pas a la verification");
  check(m.slot[BOOT_SLOT_B].valid == 1U, "le slot verifie devient valide");

  /* Premier reset : le candidat part en probation, et la marque « essaye » est posee AVANT
   * le saut. Si le candidat plante au point de ne jamais rendre la main, c'est cette marque
   * que le reset suivant retrouvera. */
  check(BootFlash_SelectBoot(&m, &trial, &changed) == BOOT_SLOT_B, "le candidat est demarre");
  check(trial, "en probation");
  check(changed, "les metadonnees doivent etre reecrites avant le saut");
  check(m.candidate_attempted == 1U, "l'essai est enregistre avant le saut, pas apres");

  /* Le candidat n'a pas confirme et la carte a reset : rollback automatique. */
  BootMeta_t failed = m;
  check(BootFlash_SelectBoot(&failed, &trial, &changed) == BOOT_SLOT_A,
        "sans confirmation, le reset suivant retombe sur l'ancien slot");
  check(!trial, "et sans nouvelle probation");
  check(changed, "le candidat abandonne doit etre efface des metadonnees");
  check(failed.candidate_slot == BOOT_SLOT_NONE, "plus de candidat en attente");
  check(failed.slot[BOOT_SLOT_B].valid == 1U,
        "l'image reste valide en flash : un rollback choisit, il ne detruit pas");

  /* Une troisieme fois ne doit rien changer : la carte est stabilisee sur A. */
  BootMeta_t again = failed;
  check(BootFlash_SelectBoot(&again, &trial, &changed) == BOOT_SLOT_A, "et s'y tient");
  check(!changed, "sans nouvelle ecriture de metadonnees");

  /* Le chemin nominal : le candidat confirme. */
  BootMeta_t ok = m;
  check(BootMeta_PromoteCandidate(&ok), "la confirmation promeut le candidat");
  check(ok.active_slot == BOOT_SLOT_B, "B devient le slot actif");
  check(ok.candidate_slot == BOOT_SLOT_NONE, "plus de candidat");
  check(BootFlash_SelectBoot(&ok, &trial, &changed) == BOOT_SLOT_B,
        "le reset suivant demarre B normalement");
  check(!trial, "sans probation");

  /* Une confirmation ne rend jamais executable une image qui n'a pas passe son CRC. */
  BootMeta_t bad;
  BootMeta_Blank(&bad);
  bad.candidate_slot = BOOT_SLOT_B;  /* designe, mais jamais verifie */
  check(!BootMeta_PromoteCandidate(&bad), "refuse de promouvoir un candidat non valide");
  check(bad.active_slot == BOOT_SLOT_A, "le slot actif est intact apres un refus");
  check(BootFlash_SelectBoot(&bad, &trial, &changed) == BOOT_SLOT_A,
        "un candidat invalide n'est jamais demarre");
  check(!trial, "ni mis en probation");
  check(changed && (bad.candidate_slot == BOOT_SLOT_NONE),
        "et il est retire des metadonnees");

  BootMeta_t none;
  BootMeta_Blank(&none);
  check(!BootMeta_PromoteCandidate(&none), "rien a promouvoir sans candidat");

  /* BOOT_ROLLBACK explicite. */
  BootMeta_t roll;
  BootMeta_Blank(&roll);
  check(!BootMeta_ClearCandidate(&roll), "sans candidat, BOOT_ROLLBACK repond ERR_STATE");
  BootMeta_SetCandidate(&roll, BOOT_SLOT_B, 4096U, 0x1U, "2.1.0");
  check(BootMeta_ClearCandidate(&roll), "avec candidat, il est annule");
  check(roll.active_slot == BOOT_SLOT_A, "et le slot actif ne bouge pas");
  check(roll.slot[BOOT_SLOT_B].valid == 1U, "l'image reste en place");
}

/* ------------------------------------------------------------------ BOOT_INFO */

static void TestInfo(void)
{
  printf("\nreponse BOOT_INFO\n");

  BootMeta_t m;
  BootMeta_Blank(&m);
  BootMeta_SetCandidate(&m, BOOT_SLOT_B, 0x1234U, 0xDEADBEEFU, "2.1.0");

  uint8_t w[BOOT_WIRE_INFO_LEN + 4U];
  memset(w, 0x5A, sizeof(w));
  BootFlash_EncodeInfo(&m, "boot-1.0.0", w);

  check((2U + BOOT_VERSION_LEN + 4U + 2U * BOOT_WIRE_SLOT_LEN) == BOOT_WIRE_INFO_LEN,
        "les champs totalisent bien les 94 octets annonces");
  check(w[BOOT_WIRE_INFO_LEN] == 0x5AU, "rien n'est ecrit au-dela des 94 octets");

  check((w[0] == 0x00U) && (w[1] == 0x02U), "protocol_version 2.0 en petit-boutien");
  check(memcmp(&w[2], "boot-1.0.0", 10U) == 0, "version du bootloader");
  check(w[2 + 10] == 0U, "le champ de version est complete par des zeros");
  check(w[18] == BOOT_SLOT_A, "slot actif");
  check(w[19] == BOOT_SLOT_B, "slot candidat");
  check(w[20] == 0U, "candidat non essaye");

  /* Les descriptions de slot commencent a l'offset 22. */
  const uint8_t *sa = &w[22];
  const uint8_t *sb = &w[22 + BOOT_WIRE_SLOT_LEN];
  check((uint32_t)sa[0] + ((uint32_t)sa[1] << 8) + ((uint32_t)sa[2] << 16) +
        ((uint32_t)sa[3] << 24) == BOOT_SLOT_A_ADDR, "adresse du slot A");
  check((uint32_t)sb[0] + ((uint32_t)sb[1] << 8) + ((uint32_t)sb[2] << 16) +
        ((uint32_t)sb[3] << 24) == BOOT_SLOT_B_ADDR, "adresse du slot B");
  check((uint32_t)sb[4] + ((uint32_t)sb[5] << 8) + ((uint32_t)sb[6] << 16) +
        ((uint32_t)sb[7] << 24) == BOOT_SLOT_CAPACITY, "capacite du slot B");
  check(sb[8] == 0x34U && sb[9] == 0x12U, "taille d'image du slot B");
  check(sb[16] == 1U, "slot B valide");
  check(sa[16] == 0U, "slot A non declare valide sans verification");
  check(memcmp(&sb[20], "2.1.0", 5U) == 0, "version du slot B");
}

int main(void)
{
  TestCrc();
  TestGeometry();
  TestVectors();
  TestRecord();
  TestPick();
  TestErase();
  TestWrite();
  TestVerify();
  TestSequence();
  TestInfo();

  printf("\n%d verifications passees, %d en echec\n", s_pass, s_fail);
  return (s_fail == 0) ? 0 : 1;
}
