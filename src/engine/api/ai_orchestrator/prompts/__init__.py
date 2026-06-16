"""Per-task prompts + JSON schemas + verification schemas.

One file per TaskType. Each exports:
  · SYSTEM_PROMPT — string for both primary + verifier (same task,
    same prompt; the orchestrator deliberately uses the same prompt
    on both models so disagreement reflects model differences, not
    prompt-engineering differences)
  · OUTPUT_SCHEMA — JSON Schema dict for structured output
  · VERIFICATION_SCHEMA — orchestrator.VerificationSchema for the
    comparison strategy

Wiring: register VERIFICATION_SCHEMA in orchestrator construction:
  >>> from .prompts.extract_trial_balance import VERIFICATION_SCHEMA as EXT_TB_SCHEMA
  >>> orchestrator = AIOrchestrator(
  ...     router=router,
  ...     verification_schemas={
  ...         TaskType.EXTRACT_TRIAL_BALANCE: EXT_TB_SCHEMA,
  ...     },
  ... )
"""
