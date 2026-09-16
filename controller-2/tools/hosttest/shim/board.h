/* Bouchon hote : juste ce que signals.c et scope.c consomment de board.h.
 * Sert a faire tourner la logique M1c hors cible, sans toolchain ARM. */
#ifndef BOARD_H
#define BOARD_H

#define BOARD_SYSCLK_HZ  144000000UL
#define PWM_FREQ_HZ      20000UL

void Board_FatalError(const char *what);

/* Sur cible, ces deux macros masquent les interruptions. Hors cible, le test est
 * mono-thread : elles comptent les entrees/sorties pour verifier l'appariement. */
extern int g_irq_depth;
#define __disable_irq()  do { g_irq_depth++; } while (0)
#define __enable_irq()   do { g_irq_depth--; } while (0)

#endif /* BOARD_H */
