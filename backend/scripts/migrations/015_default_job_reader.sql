-- Enable the new read-only result tool for unchanged default agents only.
-- Custom configurations retain explicit opt-in; historical revisions/turn pins never change.
DO $$ DECLARE row record; BEGIN
 FOR row IN SELECT p.id,p.owner_id,p.config_version,v.instructions,v.tools,v.model,v.context_bytes,v.max_output_tokens FROM agent_profiles p JOIN agent_config_versions v ON v.agent_id=p.id AND v.version=p.config_version WHERE v.instructions='' AND p.config_version<100 AND v.tools='["read_context","read_revision","create_draft","reply","read_fixture_document","list_fixture_documents","propose_fixture_note","search_memory","read_history","search_sources"]'::jsonb FOR UPDATE OF p LOOP
  INSERT INTO agent_config_versions(agent_id,version,owner_id,instructions,tools,model,context_bytes,max_output_tokens) VALUES(row.id,row.config_version+1,row.owner_id,row.instructions,row.tools||'["read_job_result"]'::jsonb,row.model,row.context_bytes,row.max_output_tokens) ON CONFLICT DO NOTHING;
  IF FOUND THEN UPDATE agent_profiles SET config_version=row.config_version+1 WHERE id=row.id AND config_version=row.config_version; END IF;
 END LOOP;
END $$;
