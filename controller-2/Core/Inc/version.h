/**
 * @file version.h
 * @brief Identite du firmware, annoncee par INFO? et par le handshake binaire.
 */
#ifndef VERSION_H
#define VERSION_H

#define FW_PRODUCT      "A2N-BLDC"
#define FW_VERSION      "2.0.0-m1c"

/* Version du protocole decrit dans ../../docs/protocol.md. Toute evolution incompatible
 * incremente le majeur ; l'interface refuse alors de dialoguer. */
#define FW_PROTO_MAJOR  2U
#define FW_PROTO_MINOR  0U

#endif /* VERSION_H */
