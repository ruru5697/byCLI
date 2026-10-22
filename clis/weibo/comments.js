import { cli, Strategy } from '@sovovs/bycli/registry';
import { runWeiboComments } from './_comments.js';
export { runWeiboComments } from './_comments.js';

cli({
    site: 'weibo',
    name: 'comments',
    access: 'read',
    description: 'Get comments on a Weibo post',
    domain: 'weibo.com',
    strategy: Strategy.COOKIE,
    args: [
        { name: 'id', required: true, positional: true, help: 'Post ID, mblogid, or Weibo post URL' },
        { name: 'limit', type: 'int', default: 20, help: 'Number of comments (max 100)' },
        { name: 'cursor', type: 'string', help: 'Resume cursor returned by Weibo' },
        { name: 'sort', type: 'string', default: 'time', choices: ['hot', 'time'], help: 'Comment order' },
        { name: 'include-replies', type: 'boolean', default: false, help: 'Include structured reply comments' },
    ],
    columns: ['rank', 'comment_id', 'author', 'author_uid', 'text', 'likes', 'reply_count', 'replies', 'time', 'next_cursor', 'has_more'],
    func: runWeiboComments,
});
