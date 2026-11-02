-- A new customer goes into its rep's route plan on its own (owner, 2026-11-03: "if Artak visits most of the Abovyan customers on
-- Tuesday and a new Abovyan customer is added, it is added to that plan"): the weekday that already holds most of the rep's customers
-- of the same subregion (else region). An On/Off switch in App configuration, ON by default.
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS auto_route_plan_new_customers BOOLEAN NOT NULL DEFAULT true;
