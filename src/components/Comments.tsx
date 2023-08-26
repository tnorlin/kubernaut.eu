import * as React from 'react';
import Giscus from '@giscus/react';

const id = 'inject-comments';

const Comments = () => {
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  return mounted ? (
        <Giscus
          id={id}
          repo="tnorlin/kubernaut.eu"
          repoId="R_kgDOIXRBqw"
          category="Announcements"
          categoryId="DIC_kwDOIXRBq84CY4YN"
          mapping="pathname"
          reactionsEnabled="1"
          emitMetadata="0"
          inputPosition="top"
          lang="en"
          loading="lazy"
        />
      ) : null
  };

export default Comments;
