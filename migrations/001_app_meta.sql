CREATE TABLE app_meta (
  id smallint PRIMARY KEY CHECK (id = 1),
  service_name text NOT NULL,
  installed_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO app_meta (id, service_name)
VALUES (1, 'bsl-mesh');
