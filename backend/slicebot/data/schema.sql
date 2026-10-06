-- SliceBot warehouse schema. DuckDB stands in for Snowflake; the SQL is
-- plain ANSI so the same queries port to a Snowflake connection.

CREATE TABLE depots (depot_id VARCHAR PRIMARY KEY, name VARCHAR, kind VARCHAR, x DOUBLE, y DOUBLE, address VARCHAR);

CREATE TABLE robots (
  robot_id VARCHAR PRIMARY KEY, model VARCHAR, batch VARCHAR, firmware VARCHAR,
  status VARCHAR,            -- active | fault | grounded | in_repair | charging
  activity VARCHAR,          -- idle | delivering | returning | stopped | in_depot | charging
  zone VARCHAR, x DOUBLE, y DOUBLE, home_depot VARCHAR,
  battery_pct INTEGER, battery_health INTEGER, lid_cycles INTEGER,
  commissioned DATE, last_service DATE, fault_code VARCHAR
);

CREATE TABLE customers (
  customer_id VARCHAR PRIMARY KEY, name VARCHAR, email VARCHAR, phone VARCHAR, address VARCHAR,
  zone VARCHAR, plan VARCHAR, member_since DATE, app_user BOOLEAN,
  x DOUBLE, y DOUBLE         -- home, on the street grid
);

CREATE TABLE orders (
  order_id VARCHAR PRIMARY KEY, customer_id VARCHAR, zone VARCHAR, robot_id VARCHAR,
  placed_at TIMESTAMP, promised_at TIMESTAMP, delivered_at TIMESTAMP,
  status VARCHAR,            -- preparing | ready | in_transit | delivered | delayed | cancelled
  items VARCHAR, subtotal DECIMAL(8,2), delivery_fee DECIMAL(8,2), tip DECIMAL(8,2), total DECIMAL(8,2),
  backup_robot_id VARCHAR, revised_eta TIMESTAMP
);

-- Live trips on the map: the street path a robot is driving right now and how far along it is.
CREATE TABLE routes (
  robot_id VARCHAR, order_id VARCHAR,
  kind VARCHAR,              -- deliver | return | stalled
  path VARCHAR,              -- JSON [[x, y], ...] over the real street graph
  depart_at TIMESTAMP, arrive_at TIMESTAMP, progress DOUBLE, km DOUBLE
);

CREATE TABLE deliveries (
  order_id VARCHAR, robot_id VARCHAR, departed_at TIMESTAMP, arrived_at TIMESTAMP, trip_minutes DOUBLE,
  box_temp_departure DOUBLE, box_temp_arrival DOUBLE, distance_km DOUBLE
);

CREATE TABLE payments (
  payment_id VARCHAR PRIMARY KEY, order_id VARCHAR, customer_id VARCHAR,
  kind VARCHAR,              -- authorization | capture | refund
  amount DECIMAL(8,2), status VARCHAR, created_at TIMESTAMP, settled_at TIMESTAMP
);

CREATE TABLE adjustments (
  adj_id VARCHAR, order_id VARCHAR, customer_id VARCHAR, kind VARCHAR, amount DECIMAL(8,2),
  reason VARCHAR, created_at TIMESTAMP, created_by VARCHAR, case_id VARCHAR
);

CREATE TABLE telemetry (
  robot_id VARCHAR, ts TIMESTAMP, battery_pct DOUBLE, motor_l_amps DOUBLE, motor_r_amps DOUBLE,
  speed_kph DOUBLE, box_temp_c DOUBLE, fault_code VARCHAR
);

CREATE TABLE tickets (
  ticket_id VARCHAR PRIMARY KEY, customer_id VARCHAR, order_id VARCHAR, robot_id VARCHAR,
  category VARCHAR, status VARCHAR, priority VARCHAR, subject VARCHAR,
  created_at TIMESTAMP, updated_at TIMESTAMP, last_note VARCHAR, assigned_team VARCHAR,
  handled_by VARCHAR, handle_minutes DOUBLE, first_contact_resolved BOOLEAN
);

CREATE TABLE work_orders (
  wo_id VARCHAR PRIMARY KEY, robot_id VARCHAR, part_key VARCHAR, sku VARCHAR,
  status VARCHAR,            -- open | proposed | scheduled | in_progress | completed | awaiting_parts
  priority VARCHAR, reason VARCHAR, source VARCHAR, created_at TIMESTAMP,
  scheduled_start TIMESTAMP, scheduled_end TIMESTAMP, completed_at TIMESTAMP,
  mechanic_id VARCHAR, depot_id VARCHAR, first_time_fix BOOLEAN, runner_robot_id VARCHAR, plan_json VARCHAR
);

CREATE TABLE parts (sku VARCHAR PRIMARY KEY, name VARCHAR, part_key VARCHAR, skill VARCHAR,
                    repair_minutes INTEGER, unit_cost DECIMAL(8,2));

CREATE TABLE inventory (sku VARCHAR, location_id VARCHAR, bin VARCHAR, qty_on_hand INTEGER,
                        qty_reserved INTEGER, reorder_point INTEGER);

CREATE TABLE mechanics (mechanic_id VARCHAR PRIMARY KEY, name VARCHAR, depot_id VARCHAR, skills VARCHAR,
                        shift_start TIMESTAMP, shift_end TIMESTAMP);

CREATE TABLE demand_forecast (zone VARCHAR, hour INTEGER, orders_per_hour DOUBLE);

CREATE TABLE contacts (contact_id VARCHAR PRIMARY KEY, customer_id VARCHAR, channel VARCHAR, verified BOOLEAN,
                       message VARCHAR, received_at TIMESTAMP);

-- The menu the Menu bot recommends from. Tags and allergens are what the code filters on;
-- the description is what the search matches against.
CREATE TABLE menu (
  item_id VARCHAR PRIMARY KEY, name VARCHAR, category VARCHAR,   -- pizza | side | drink | dessert
  price DECIMAL(8,2), serves INTEGER, description VARCHAR,
  tags VARCHAR,              -- comma list: vegetarian, vegan, gluten_free, spicy, kid_friendly
  allergens VARCHAR,         -- comma list: gluten, dairy, egg, soy, tree_nuts, fish
  available BOOLEAN
);
