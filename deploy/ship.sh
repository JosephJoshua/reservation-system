#!/bin/sh
# Ships a commit to the server and runs it on staging. Run it from your own machine:
#   RS_HOST=root@1.2.3.4 deploy/ship.sh [git-ref]      (default: origin/main)
# Only committed code is sent. Once staging looks right, promote it on the server.
set -eu
host=${RS_HOST:?set RS_HOST to the server, such as root@1.2.3.4 or an ssh config alias}
ref=${1:-origin/main}
tag=$(git rev-parse --short=12 "$ref^{commit}")
dir=/srv/rs/releases/$tag

echo "shipping $ref ($tag) to $host"
git archive --format=tar "$tag" | ssh "$host" "rm -rf $dir && mkdir -p $dir && tar -x -C $dir"
ssh "$host" "$dir/deploy/rs.sh build $dir $tag && $dir/deploy/rs.sh staging $tag"
echo "staging runs $tag. To put it in production: ssh $host /srv/rs/rs.sh promote"
