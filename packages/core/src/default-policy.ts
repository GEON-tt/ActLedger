export const DEFAULT_POLICY = `version: 1
defaults:
  unknown_action: require_approval
  timezone: UTC
  content_mode: strict
  approval:
    channels: [cli]
    timeout: 15m
    allow_edit: true
    min_assurance: app_asserted
  claim_deadline: 24h
  execution_timeout: 15m

coverage:
  - action: email.*
    mode: recorded
    via: cli-demo
  - action: db.*
    mode: recorded
    via: credential-gate

actions:
  email.read:
    level: read
  email.send:
    level: send
    blast_radius: others
    reversible: false
  calendar.create:
    level: write
    blast_radius: self
    reversible: true
  db.delete:
    level: delete
    reversible: false

rules:
  - id: deny-prod-delete-at-night
    match:
      action: db.delete
      attrs.env: prod
      time.hour:
        not_between: [9, 20]
    effect: deny

  - id: prod-delete-step-up
    match:
      action: db.delete
      attrs.env: prod
    effect: require_approval
    approval:
      step_up: webauthn
      min_assurance: user_signed
      timeout: 10m
      allow_edit: false
    execution_timeout: 5m

  - id: read-allow
    match:
      level: read
    effect: allow

  - id: email-external-approve
    match:
      action: email.send
    effect: require_approval
    approval:
      min_assurance: channel_verified
      allow_edit: true

  - id: calendar-allow
    match:
      action: calendar.create
    effect: allow
`;
