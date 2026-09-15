/**
 * @file console.h
 * @brief Console ASCII de diagnostic, ligne par ligne.
 *
 * L'accumulation des octets et le choix du canal appartiennent au routeur de reception
 * (comm/rx_router.h) : la console ne voit que des lignes completes, deja separees du flux
 * binaire. Elle n'a donc plus d'etat propre.
 */
#ifndef CONSOLE_H
#define CONSOLE_H

#ifdef __cplusplus
extern "C" {
#endif

void Console_Init(void);

/** Execute une ligne complete, terminateur retire, et emet la reponse. Ne bloque jamais. */
void Console_ExecuteLine(const char *line);

/** Reponse normalisee quand le routeur a du abandonner une ligne trop longue. */
void Console_ReplyOverflow(void);

#ifdef __cplusplus
}
#endif
#endif /* CONSOLE_H */
