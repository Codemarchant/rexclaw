# Copyright 2026 Codemarchant
"""Error types shared across the server. Mirror the Odoo exception split the
ported services were written against, so the port stays mechanical:

  UserError       → 400, message shown to the user verbatim
  AccessError     → 403
  ValidationError → 422
"""


class UserError(Exception):
    status_code = 400


class AccessError(UserError):
    status_code = 403


class ValidationError(UserError):
    status_code = 422
