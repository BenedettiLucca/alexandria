REVOKE EXECUTE ON FUNCTION public.prune_tool_call_log(integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.prune_tool_call_log(integer) FROM anon;
REVOKE EXECUTE ON FUNCTION public.prune_tool_call_log(integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.prune_tool_call_log(integer) TO service_role;
