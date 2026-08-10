-- Keep the visible workspace identity explicit so branch users never mistake
-- their isolated OS for the headquarters workspace.

SELECT pg_advisory_xact_lock(hashtext('peakos-workspace-labels-v1'));

UPDATE peakos_workspaces
   SET name = CASE slug
     WHEN 'peak' THEN '피크마케팅 본사'
     WHEN 'daegu' THEN '피크마케팅 대구지사'
     WHEN 'jeonju' THEN '피크마케팅 전주지사'
     WHEN 'build-solution' THEN '빌드솔루션'
     ELSE name
   END,
       updated_at = NOW()
 WHERE slug IN ('peak', 'daegu', 'jeonju', 'build-solution');
