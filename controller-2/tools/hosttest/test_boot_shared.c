/* Harnais hote pour la decision de probation du bootloader A/B.
 *
 * Confirmer une probation rend un firmware actif de facon permanente ; refuser de la
 * confirmer provoque un rollback. Les deux erreurs coutent cher et aucune ne se voit en
 * relisant le code, d'ou des vecteurs explicites.
 *
 * Le module est compile avec BOOT_SHARED_HOSTTEST : seule la fonction de decision est
 * batie, sans HAL ni acces a la zone SRAM partagee. */
#include <stdio.h>

#include "boot_shared.h"

static int s_pass = 0, s_fail = 0;

static void check(int cond, const char *what)
{
  if (cond) { s_pass++; }
  else { s_fail++; printf("  ECHEC : %s\n", what); }
}

int main(void)
{
  const uint32_t ms = BOOT_TRIAL_CONFIRM_MS;
  const uint32_t tk = BOOT_TRIAL_CONFIRM_TICKS;

  printf("decision de probation\n");

  check(BootShared_ShouldConfirm(ms, tk, false),
        "confirme au seuil exact : duree et ticks atteints, pont au repos");
  check(BootShared_ShouldConfirm(ms * 10U, tk * 10U, false),
        "confirme bien au-dela des seuils");

  check(!BootShared_ShouldConfirm(ms - 1U, tk, false),
        "refuse une milliseconde trop tot");
  check(!BootShared_ShouldConfirm(ms, tk - 1U, false),
        "refuse un tick trop tot");
  check(!BootShared_ShouldConfirm(0U, 0U, false),
        "refuse au tout premier passage");

  /* Le cas qui compte : la superloop tourne, l'ISR non. C'est la panne du firmware v1, ou
   * la boucle de controle n'etait jamais appelee. Une confirmation sur la seule duree la
   * laisserait passer, et le rollback ne se declencherait pas. */
  check(!BootShared_ShouldConfirm(ms * 100U, 0U, false),
        "refuse une superloop vivante avec une ISR morte");

  /* Et celui-ci : un candidat qui a deja mis de la puissance sur le moteur n'est pas dans
   * une initialisation sure, il en est sorti. */
  check(!BootShared_ShouldConfirm(ms * 10U, tk * 10U, true),
        "refuse tant que le pont de puissance est actif");
  check(!BootShared_ShouldConfirm(ms, tk, true),
        "le pont actif prime sur des seuils atteints");

  /* Les seuils doivent laisser de la marge sous la probation de deux secondes annoncee par
   * la specification : confirmer au plus juste ne laisserait rien au demarrage USB. */
  check(ms < 2000U, "le seuil de duree tient sous les 2 s de probation");
  check(tk == 10000U, "10 000 ticks = 500 ms de boucle a 20 kHz");

  printf("\n%d verifications passees, %d en echec\n", s_pass, s_fail);
  return (s_fail == 0) ? 0 : 1;
}
