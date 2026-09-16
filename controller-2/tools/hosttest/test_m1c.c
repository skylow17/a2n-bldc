/* Harnais hote pour les modules M1c (signals.c, scope.c).
 *
 * Il ne remplace pas une recette sur carte : il verifie la logique qui ne depend pas du
 * materiel a layout du dictionnaire de signaux, validation de configuration, anneau,
 * decimation, declenchement, ordre logique des points et horodatage. */
#include <stdio.h>
#include <string.h>
#include <math.h>

#include "comm/signals.h"
#include "comm/scope.h"

int g_irq_depth = 0;
static int s_fatal = 0;
void Board_FatalError(const char *what) { (void)what; s_fatal = 1; }

static int s_pass = 0, s_fail = 0;

static void check(int cond, const char *what)
{
  if (cond) { s_pass++; }
  else { s_fail++; printf("  ECHEC : %s\n", what); }
}

static void check_f(float got, float want, float tol, const char *what)
{
  if (fabsf(got - want) <= tol) { s_pass++; }
  else { s_fail++; printf("  ECHEC : %s (obtenu %g, attendu %g)\n", what, got, want); }
}

/* --- generation d'instantanes ------------------------------------------------ */

static uint32_t s_ticks;

static void reset_ticks(void) { s_ticks = 0; }

/* Pousse un tick dont ia vaut `ia`. Les autres voies portent des valeurs distinctes
 * pour que l'ordre des colonnes soit verifiable. */
static void tick(float ia)
{
  Signal_Snapshot_t snap;
  memset(&snap, 0, sizeof(snap));
  s_ticks++;
  snap.ticks = s_ticks;
  snap.cycles_last = 720;   /* 5 us a 144 MHz */
  snap.cycles_max = 1440;
  snap.raw_ia = (uint16_t)ia;
  snap.raw_ib = (uint16_t)(ia + 1000.0f);
  snap.raw_ic = (uint16_t)(ia + 2000.0f);
  Scope_OnControlTick(&snap);
}

static ScopeConfig_t base_config(uint16_t depth, uint16_t decim, uint16_t pre,
                                 uint8_t mode, uint16_t trig_id, float thr)
{
  ScopeConfig_t c;
  memset(&c, 0, sizeof(c));
  c.depth = depth;
  c.decimation = decim;
  c.pretrigger_samples = pre;
  c.trigger_mode = mode;
  c.signal_count = 3;
  c.trigger_signal_id = trig_id;
  c.threshold = thr;
  c.signal_ids[0] = 1;
  c.signal_ids[1] = 2;
  c.signal_ids[2] = 3;
  return c;
}

/* --- 1. dictionnaire de signaux ---------------------------------------------- */

static void test_signals(void)
{
  printf("dictionnaire de signaux\n");
  check(SIGNAL_ENTRY_WIRE_LEN == 44, "SIGNAL_ENTRY_WIRE_LEN vaut 44");
  check(Signal_Count() == 6, "6 signaux publies");

  uint8_t e[64];
  memset(e, 0xAA, sizeof(e));
  check(Signal_SerializeEntry(0, e), "serialisation de l'entree 0");
  check(e[0] == 1 && e[1] == 0, "id = 1, little-endian");
  check(e[2] == 6, "type = 6 (f32)");
  check(e[3] == 0, "flags = 0");
  check(strncmp((const char *)&e[4], "current.raw_ia_count", 20) == 0, "nom en clair");
  check(e[4 + 20] == 0, "nom complete par des zeros");
  check(strncmp((const char *)&e[4 + 32], "count", 5) == 0, "unite en clair");
  check(e[4 + 32 + 5] == 0, "unite completee par des zeros");
  check(!Signal_SerializeEntry(6, e), "index hors table refuse");

  check(Signal_IsKnown(1) && Signal_IsKnown(6), "ids 1 et 6 connus");
  check(!Signal_IsKnown(0) && !Signal_IsKnown(7), "ids 0 et 7 inconnus");

  Signal_Snapshot_t s;
  memset(&s, 0, sizeof(s));
  s.raw_ia = 2048; s.raw_ib = 100; s.raw_ic = 4095;
  s.cycles_last = 7200;   /* 50 us a 144 MHz : exactement une periode de boucle */
  s.cycles_max = 14400;

  float v = 0.0f;
  check(Signal_Read(1, &s, &v), "lecture id 1"); check_f(v, 2048.0f, 0.001f, "raw_ia");
  check(Signal_Read(2, &s, &v), "lecture id 2"); check_f(v, 100.0f, 0.001f, "raw_ib");
  check(Signal_Read(3, &s, &v), "lecture id 3"); check_f(v, 4095.0f, 0.001f, "raw_ic");
  check(Signal_Read(4, &s, &v), "lecture id 4"); check_f(v, 50000.0f, 0.01f, "duration_ns");
  check(Signal_Read(5, &s, &v), "lecture id 5"); check_f(v, 100000.0f, 0.01f, "max_duration_ns");
  check(Signal_Read(6, &s, &v), "lecture id 6"); check_f(v, 100.0f, 0.001f, "load_pct a 50 us");
  check(!Signal_Read(99, &s, &v), "id inconnu refuse");
}

/* --- 2. validation de configuration ------------------------------------------ */

static void test_config_validation(void)
{
  printf("validation de SCOPE_CONFIG\n");
  ScopeConfig_t c;

  c = base_config(2048, 1, 0, SCOPE_TRIG_IMMEDIATE, 1, 0.0f);
  check(Scope_Configure(&c), "configuration nominale acceptee");

  c = base_config(0, 1, 0, SCOPE_TRIG_IMMEDIATE, 1, 0.0f);
  check(!Scope_Configure(&c), "depth = 0 refuse");
  c = base_config(2049, 1, 0, SCOPE_TRIG_IMMEDIATE, 1, 0.0f);
  check(!Scope_Configure(&c), "depth > 2048 refuse");
  c = base_config(8, 0, 0, SCOPE_TRIG_IMMEDIATE, 1, 0.0f);
  check(!Scope_Configure(&c), "decimation = 0 refusee");
  c = base_config(8, 257, 0, SCOPE_TRIG_IMMEDIATE, 1, 0.0f);
  check(!Scope_Configure(&c), "decimation > 256 refusee");
  c = base_config(8, 1, 8, SCOPE_TRIG_IMMEDIATE, 1, 0.0f);
  check(!Scope_Configure(&c), "pretrigger = depth refuse");
  c = base_config(8, 1, 0, 4, 1, 0.0f);
  check(!Scope_Configure(&c), "trigger_mode = 4 refuse");

  c = base_config(8, 1, 0, SCOPE_TRIG_IMMEDIATE, 1, 0.0f);
  c.signal_count = 0;
  check(!Scope_Configure(&c), "signal_count = 0 refuse");
  c.signal_count = 5;
  check(!Scope_Configure(&c), "signal_count = 5 refuse");

  c = base_config(8, 1, 0, SCOPE_TRIG_IMMEDIATE, 1, 0.0f);
  c.signal_ids[1] = 99;
  check(!Scope_Configure(&c), "identifiant de signal inconnu refuse");

  c = base_config(8, 1, 0, SCOPE_TRIG_IMMEDIATE, 1, 0.0f);
  c.signal_ids[1] = 1;
  check(!Scope_Configure(&c), "doublon de signal refuse");

  c = base_config(8, 1, 0, SCOPE_TRIG_RISING, 4, 0.0f);
  check(!Scope_Configure(&c), "trigger hors selection refuse (mode front)");
  c = base_config(8, 1, 0, SCOPE_TRIG_IMMEDIATE, 4, 0.0f);
  check(Scope_Configure(&c), "trigger hors selection tolere en immediat");

  c = base_config(8, 1, 0, SCOPE_TRIG_RISING, 1, NAN);
  check(!Scope_Configure(&c), "seuil NaN refuse");

  /* La configuration refusee ne doit pas avoir ecrase la precedente. */
  c = base_config(16, 2, 4, SCOPE_TRIG_RISING, 2, 1.5f);
  check(Scope_Configure(&c), "configuration a conserver");
  ScopeConfig_t bad = base_config(0, 1, 0, SCOPE_TRIG_IMMEDIATE, 1, 0.0f);
  (void)Scope_Configure(&bad);
  const ScopeConfig_t *cur = Scope_GetConfig();
  check(cur->depth == 16 && cur->decimation == 2 && cur->pretrigger_samples == 4 &&
        cur->trigger_signal_id == 2, "configuration intacte apres refus");
}

/* --- 3. capture immediate ---------------------------------------------------- */

static void test_immediate(void)
{
  printf("capture immediate, pretrigger 0\n");
  ScopeConfig_t c = base_config(8, 1, 0, SCOPE_TRIG_IMMEDIATE, 1, 0.0f);
  check(Scope_Configure(&c), "configuration");
  reset_ticks();

  ScopeStatus_t st;
  Scope_GetStatus(&st);
  check(st.state == SCOPE_IDLE, "etat initial idle");
  check(st.trigger_index == 0xFFFF, "trigger_index 0xffff avant declenchement");
  check(st.sample_period_ns == 50000, "sample_period_ns = 50000 a decimation 1");

  float dummy = 0.0f;
  check(!Scope_ReadValue(0, 0, &dummy), "lecture refusee hors de complete");

  check(Scope_Arm(), "armement");
  check(Scope_ConsumeStatusDirty(), "transition signalee a l'armement");
  check(!Scope_ConsumeStatusDirty(), "drapeau efface par la lecture");

  for (int i = 0; i < 7; i++) { tick((float)(10 + i)); }
  Scope_GetStatus(&st);
  check(st.state == SCOPE_TRIGGERED, "declenchement des le premier point");
  check(st.captured == 7, "7 points conserves en cours de capture");

  tick(17.0f);
  Scope_GetStatus(&st);
  check(st.state == SCOPE_COMPLETE, "capture terminee au huitieme point");
  check(st.captured == 8, "captured = depth");
  check(st.trigger_index == 0, "trigger_index = pretrigger = 0");
  check(st.start_timestamp_us == 0, "horodatage du premier point = 0");
  check(st.signal_count == 3, "3 colonnes");
  check(Scope_ConsumeStatusDirty(), "transition vers complete signalee");

  for (uint16_t i = 0; i < 8; i++) {
    float v = 0.0f;
    check(Scope_ReadValue(i, 0, &v), "lecture d'un point");
    check_f(v, (float)(10 + i), 0.001f, "ordre logique des points");
    check(Scope_ReadValue(i, 1, &v), "lecture colonne 1");
    check_f(v, (float)(1010 + i), 0.001f, "colonne 1 = signal 2");
    check(Scope_ReadValue(i, 2, &v), "lecture colonne 2");
    check_f(v, (float)(2010 + i), 0.001f, "colonne 2 = signal 3");
  }
  float v = 0.0f;
  check(!Scope_ReadValue(8, 0, &v), "point hors capture refuse");
  check(!Scope_ReadValue(0, 3, &v), "colonne hors selection refusee");

  /* Les ticks qui suivent la fin ne doivent plus rien changer. */
  tick(99.0f);
  check(Scope_ReadValue(7, 0, &v) && fabsf(v - 17.0f) < 0.001f,
        "tampon fige apres complete");
}

/* --- 4. pretrigger et anneau ------------------------------------------------- */

static void test_pretrigger_immediate(void)
{
  printf("capture immediate, pretrigger 3\n");
  ScopeConfig_t c = base_config(8, 1, 3, SCOPE_TRIG_IMMEDIATE, 1, 0.0f);
  check(Scope_Configure(&c), "configuration");
  reset_ticks();
  check(Scope_Arm(), "armement");

  for (int i = 0; i < 3; i++) { tick((float)(10 + i)); }
  ScopeStatus_t st;
  Scope_GetStatus(&st);
  check(st.state == SCOPE_ARMED, "pas encore declenche tant que le pretrigger se remplit");

  tick(13.0f);   /* 4e point : pretrigger satisfait, declenchement */
  Scope_GetStatus(&st);
  check(st.state == SCOPE_TRIGGERED, "declenchement au 4e point");
  check(st.trigger_index == 3, "trigger_index = 3");
  check(st.start_timestamp_us == 0, "premier point conserve = premier tick");

  for (int i = 0; i < 4; i++) { tick((float)(14 + i)); }
  Scope_GetStatus(&st);
  check(st.state == SCOPE_COMPLETE, "capture terminee");
  check(st.captured == 8, "8 points");

  for (uint16_t i = 0; i < 8; i++) {
    float v = 0.0f;
    (void)Scope_ReadValue(i, 0, &v);
    check_f(v, (float)(10 + i), 0.001f, "ordre logique avec pretrigger");
  }
}

/* --- 5. front montant, anneau enroule ---------------------------------------- */

static void test_rising_edge(void)
{
  printf("declenchement sur front montant, anneau enroule\n");
  /* depth 8, pretrigger 4 : l'anneau tourne plusieurs fois avant le franchissement. */
  ScopeConfig_t c = base_config(8, 1, 4, SCOPE_TRIG_RISING, 1, 100.0f);
  check(Scope_Configure(&c), "configuration");
  reset_ticks();
  check(Scope_Arm(), "armement");

  /* 20 points sous le seuil : l'anneau boucle deux fois et demie. */
  for (int i = 0; i < 20; i++) { tick(50.0f); }
  ScopeStatus_t st;
  Scope_GetStatus(&st);
  check(st.state == SCOPE_ARMED, "aucun declenchement sous le seuil");
  check(st.captured == 8, "l'anneau est plein et se recycle");

  tick(150.0f);   /* franchissement : 21e point */
  Scope_GetStatus(&st);
  check(st.state == SCOPE_TRIGGERED, "declenche au franchissement");
  check(st.trigger_index == 4, "trigger_index = pretrigger");
  /* Premier point conserve = 21 - 4 = tick 17, soit (17-1) x 50 us. */
  check(st.start_timestamp_us == 800, "horodatage du premier point conserve");

  for (int i = 0; i < 3; i++) { tick(160.0f); }
  Scope_GetStatus(&st);
  check(st.state == SCOPE_COMPLETE, "capture terminee apres 3 points post-trigger");

  float v = 0.0f;
  for (uint16_t i = 0; i < 4; i++) {
    (void)Scope_ReadValue(i, 0, &v);
    check_f(v, 50.0f, 0.001f, "pretrigger : points sous le seuil");
  }
  (void)Scope_ReadValue(4, 0, &v);
  check_f(v, 150.0f, 0.001f, "le point de declenchement est a trigger_index");
  for (uint16_t i = 5; i < 8; i++) {
    (void)Scope_ReadValue(i, 0, &v);
    check_f(v, 160.0f, 0.001f, "points post-trigger");
  }
}

/* --- 6. front descendant ----------------------------------------------------- */

static void test_falling_edge(void)
{
  printf("declenchement sur front descendant\n");
  ScopeConfig_t c = base_config(8, 1, 0, SCOPE_TRIG_FALLING, 1, 100.0f);
  check(Scope_Configure(&c), "configuration");
  reset_ticks();
  check(Scope_Arm(), "armement");

  for (int i = 0; i < 5; i++) { tick(150.0f); }
  ScopeStatus_t st;
  Scope_GetStatus(&st);
  check(st.state == SCOPE_ARMED, "pas de declenchement sur un front montant absent");

  tick(50.0f);
  Scope_GetStatus(&st);
  check(st.state == SCOPE_TRIGGERED, "declenche sur la descente");

  float v = 0.0f;
  for (int i = 0; i < 7; i++) { tick(50.0f); }
  Scope_GetStatus(&st);
  check(st.state == SCOPE_COMPLETE, "capture terminee");
  (void)Scope_ReadValue(0, 0, &v);
  check_f(v, 50.0f, 0.001f, "le point 0 est le point de declenchement");
}

/* --- 7. decimation ----------------------------------------------------------- */

static void test_decimation(void)
{
  printf("decimation\n");
  ScopeConfig_t c = base_config(4, 3, 0, SCOPE_TRIG_IMMEDIATE, 1, 0.0f);
  check(Scope_Configure(&c), "configuration a decimation 3");
  reset_ticks();
  check(Scope_Arm(), "armement");

  ScopeStatus_t st;
  Scope_GetStatus(&st);
  check(st.sample_period_ns == 150000, "sample_period_ns = 50000 x 3");

  /* 12 ticks -> 4 points conserves : les ticks 3, 6, 9, 12. */
  for (int i = 1; i <= 12; i++) { tick((float)i); }
  Scope_GetStatus(&st);
  check(st.state == SCOPE_COMPLETE, "capture terminee apres 12 ticks");

  const float want[4] = { 3.0f, 6.0f, 9.0f, 12.0f };
  for (uint16_t i = 0; i < 4; i++) {
    float v = 0.0f;
    (void)Scope_ReadValue(i, 0, &v);
    check_f(v, want[i], 0.001f, "un point conserve tous les 3 ticks");
  }
}

/* --- 8. refus pendant une capture -------------------------------------------- */

static void test_busy(void)
{
  printf("refus pendant une capture\n");
  ScopeConfig_t c = base_config(8, 1, 4, SCOPE_TRIG_RISING, 1, 100.0f);
  check(Scope_Configure(&c), "configuration");
  reset_ticks();
  check(Scope_Arm(), "armement");

  /* Le reamorcage est licite et repart de zero : le protocole n'attache ERR_BUSY qu'a
   * SCOPE_CONFIG, et le device simule l'accepte. */
  for (int i = 0; i < 3; i++) { tick(50.0f); }
  ScopeStatus_t mid;
  Scope_GetStatus(&mid);
  check(mid.captured == 3, "3 points avant reamorcage");
  check(Scope_Arm(), "reamorcage accepte pendant l'armement");
  Scope_GetStatus(&mid);
  check(mid.state == SCOPE_ARMED && mid.captured == 0, "reamorcage : tampon remis a zero");

  ScopeConfig_t other = base_config(16, 1, 0, SCOPE_TRIG_IMMEDIATE, 1, 0.0f);
  check(!Scope_Configure(&other), "reconfiguration refusee pendant l'armement");
  check(Scope_GetConfig()->depth == 8, "configuration inchangee");

  /* Une fois terminee, les deux redeviennent possibles. */
  for (int i = 0; i < 4; i++) { tick(50.0f); }
  tick(150.0f);
  for (int i = 0; i < 3; i++) { tick(160.0f); }
  ScopeStatus_t st;
  Scope_GetStatus(&st);
  check(st.state == SCOPE_COMPLETE, "capture terminee");
  check(Scope_Configure(&other), "reconfiguration acceptee apres complete");

  /* Une capture armee sur un front qui n'arrive jamais ne peut plus etre reconfiguree :
   * le protocole ne prevoit pas de desarmement. Le test fige ce comportement pour qu'un
   * changement de specification se voie ici. */
  ScopeConfig_t never = base_config(4, 1, 0, SCOPE_TRIG_RISING, 1, 50000.0f);
  check(Scope_Configure(&never), "configuration a seuil tres haut");
  check(Scope_Arm(), "armement");
  for (int i = 0; i < 50; i++) { tick(1.0f); }
  Scope_GetStatus(&st);
  check(st.state == SCOPE_ARMED, "toujours arme : le seuil n'est jamais franchi");
  check(!Scope_Configure(&other), "reconfiguration impossible : manque de la specification");

  /* Le seul retour au repos est d'aller au bout d'une capture — c'est precisement le
   * manque signale ci-dessus. On franchit donc le seuil pour liberer le scope. */
  for (int i = 0; i < 4; i++) { tick(60000.0f); }
  Scope_GetStatus(&st);
  check(st.state == SCOPE_COMPLETE, "capture liberee par un franchissement");
}

/* --- 9. profondeur maximale -------------------------------------------------- */

static void test_full_depth(void)
{
  printf("profondeur maximale\n");
  ScopeConfig_t c = base_config(2048, 1, 0, SCOPE_TRIG_IMMEDIATE, 1, 0.0f);
  c.signal_count = 4;
  c.signal_ids[3] = 4;
  check(Scope_Configure(&c), "2048 points, 4 signaux");
  reset_ticks();
  check(Scope_Arm(), "armement");
  for (int i = 0; i < 2048; i++) { tick((float)(i % 4000)); }
  ScopeStatus_t st;
  Scope_GetStatus(&st);
  check(st.state == SCOPE_COMPLETE, "capture complete de 2048 points");
  check(st.captured == 2048, "2048 points conserves");
  float first = 0.0f, last = 0.0f;
  (void)Scope_ReadValue(0, 0, &first);
  (void)Scope_ReadValue(2047, 0, &last);
  check_f(first, 0.0f, 0.001f, "premier point");
  check_f(last, 2047.0f, 0.001f, "dernier point");
  /* La 4e colonne porte loop.duration_ns : 720 cycles a 144 MHz = 5000 ns. */
  float dur = 0.0f;
  (void)Scope_ReadValue(100, 3, &dur);
  check_f(dur, 5000.0f, 0.1f, "colonne 3 = loop.duration_ns");
}

int main(void)
{
  Scope_Init();
  if (s_fatal) { printf("Scope_Init a appele Board_FatalError\n"); return 1; }

  const ScopeConfig_t *d = Scope_GetConfig();
  printf("configuration par defaut\n");
  check(d->depth == 2048 && d->decimation == 1 && d->pretrigger_samples == 0 &&
        d->trigger_mode == SCOPE_TRIG_IMMEDIATE && d->signal_count == 3 &&
        d->signal_ids[0] == 1 && d->signal_ids[1] == 2 && d->signal_ids[2] == 3,
        "defaut identique au device simule");

  test_signals();
  test_config_validation();
  test_immediate();
  test_pretrigger_immediate();
  test_rising_edge();
  test_falling_edge();
  test_decimation();
  test_busy();
  test_full_depth();

  check(g_irq_depth == 0, "masquages d'interruption apparies");

  printf("\n%d verifications passees, %d en echec\n", s_pass, s_fail);
  return (s_fail == 0) ? 0 : 1;
}
