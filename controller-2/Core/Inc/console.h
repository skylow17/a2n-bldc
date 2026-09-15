/**
 * @file console.h
 * @brief Console ASCII de diagnostic, ligne par ligne.
 */
#ifndef CONSOLE_H
#define CONSOLE_H

#ifdef __cplusplus
extern "C" {
#endif

void Console_Init(void);

/** A appeler a chaque tour de superloop. Consomme ce qui est arrive, execute les lignes
 *  completes. Ne bloque jamais. */
void Console_Process(void);

#ifdef __cplusplus
}
#endif
#endif /* CONSOLE_H */
