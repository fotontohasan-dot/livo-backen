<%- include('partials/head') %>
<%- include('partials/navbar') %>

<div class="container" style="padding-top: 14px;">

  <h4 style="margin-bottom: 16px; color: var(--gold);">
    <%= title || 'আসন্ন ম্যাচসমূহ' %>
  </h4>

  <% if (matches && matches.length > 0) { %>
    <% matches.forEach(match => { %>
      <a href="/matches/<%= match.id %>" style="text-decoration: none; color: inherit;">
        <div class="card" style="margin-bottom: 12px; padding: 14px;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <div>
              <div style="font-weight: 600; font-size: 15px;">
                <%= match.teams ? match.teams[0] + ' vs ' + match.teams[1] : match.title %>
              </div>
              <div style="font-size: 12px; color: var(--text-muted);">
                <%= match.sport || 'Cricket' %> • <%= match.league || '' %>
              </div>
            </div>
            <div style="text-align: right;">
              <span class="badge <%= match.status === 'live' ? 'bg-success' : 'bg-warning' %>">
                <%= match.status ? match.status.toUpperCase() : 'Upcoming' %>
              </span>
            </div>
          </div>
        </div>
      </a>
    <% }) %>
  <% } else { %>
    <div class="card text-center" style="padding: 60px 20px;">
      <h3>কোনো ম্যাচ পাওয়া যায়নি</h3>
      <p style="color: var(--text-muted);">এখনো কোনো ম্যাচ আসেনি। কিছুক্ষণ পর আবার চেক করুন।</p>
    </div>
  <% } %>

</div>

<%- include('partials/bottom-nav') %>
