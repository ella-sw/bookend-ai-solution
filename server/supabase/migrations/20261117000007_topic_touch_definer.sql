-- Supabase에서 사용자 삭제가 "permission denied for table materials"로 실패하던 문제 고침.
--
-- 사용자를 지우면 material_topics도 같이 지워지고, 그 뒤(AFTER 트리거)에
-- touch_material_from_topics가 `update materials`를 한다. AFTER 트리거는 삭제를 시작한
-- 계정(supabase_auth_admin)의 권한으로 실행되는데, 그 계정에는 materials 권한이 없다.
--
-- 이 함수만 만든 사람(테이블 주인) 권한으로 실행한다 (SECURITY DEFINER).
-- 하는 일은 "그 소재의 updated_at = now()" 하나뿐이고 search_path도 고정돼 있다 (0006).
-- 트리거 함수라 직접 부를 수 없고, 브라우저 역할의 실행 권한은 0004에서 이미 뺐다.

alter function touch_material_from_topics() security definer;
