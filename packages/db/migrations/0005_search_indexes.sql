CREATE INDEX nodes_title_search_idx
  ON nodes USING GIN (to_tsvector('simple', title));

CREATE INDEX node_documents_content_search_idx
  ON node_documents USING GIN (to_tsvector('simple', content::text));
